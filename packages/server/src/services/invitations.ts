/**
 * Invitation service (PRD §4.4, §8.3).
 *
 * Operations:
 *   - inviteMember: invite a user by email to a semester.
 *     If the email maps to an existing user → create membership directly.
 *     Otherwise → insert a pending_invitations row + send email.
 *   - activatePendingInvitations: called from OAuth callback; consumes all
 *     open pending_invitations for a given verified email.
 *   - revokeInvitation: hard-delete a pending_invitations row.
 *
 * All writes are transactional. Email sending is fire-and-forget OUTSIDE the
 * transaction (nodemailer may not be available; a failure there must not roll
 * back the DB insert).
 */

import { eq, and, isNull, sql, inArray } from 'drizzle-orm';
import { users, memberships, pending_invitations } from '../db/schema.js';
import type { DrizzleDb } from '../db/client.js';
import { withTransaction } from '../db/client.js';
import { Errors } from '../api/v1/errors.js';
import type { SendEmailFn } from '../email/transport.js';

// ---------------------------------------------------------------------------
// Type aliases
// ---------------------------------------------------------------------------

export type Role = 'admin' | 'grader';

export type UUID = string;

export interface MemberSummary {
  user_id: string;
  email: string;
  display_name: string;
  role: Role;
  granted_at: string;
  granted_by_email: string;
}

export interface PendingSummary {
  id: string;
  email: string;
  role: Role;
  invited_at: string;
  invited_by_email: string;
}

export type InviteResult =
  | { kind: 'member'; member: MemberSummary }
  | { kind: 'pending'; pending: PendingSummary };

// ---------------------------------------------------------------------------
// Error detection helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if `err` is a Postgres unique constraint violation (code 23505).
 * Checks both the top-level and the `.cause` wrapper from postgres.js.
 */
function isUniqueConstraintViolation(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if ((err as unknown as { code?: string }).code === '23505') return true;
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof Error && (cause as unknown as { code?: string }).code === '23505')
    return true;
  return false;
}

// ---------------------------------------------------------------------------
// inviteMember
// ---------------------------------------------------------------------------

export interface InviteMemberDeps {
  sendEmail?: SendEmailFn;
}

/**
 * Invite a user by email to a semester.
 *
 * Transaction scope:
 *   (a) Look up user by LOWER(email).
 *   (b) Check for existing membership → MEMBER_ALREADY.
 *   (c) If user found → insert membership directly.
 *   (d) If user not found → insert pending_invitations row (INVITATION_ALREADY_OPEN on conflict).
 *
 * Email sending (if applicable) happens OUTSIDE the transaction so a nodemailer
 * failure doesn't roll back the DB state.
 */
export async function inviteMember(
  db: DrizzleDb,
  semesterId: UUID,
  email: string,
  role: Role,
  invitedBy: UUID,
  deps: InviteMemberDeps = {},
): Promise<InviteResult> {
  const normalizedEmail = email.toLowerCase();
  let emailSendArgs:
    | { to: string; subject: string; text: string; html: string; pendingSummary: PendingSummary }
    | undefined;
  let result: InviteResult;

  result = await withTransaction(db, async (tx) => {
    // (a) Look up existing user by email (case-insensitive, uses functional index).
    const existingUsers = await tx
      .select({
        id: users.id,
        email: users.email,
        display_name: users.display_name,
      })
      .from(users)
      .where(sql`LOWER(${users.email}) = ${normalizedEmail}`)
      .limit(1);

    const existingUser = existingUsers[0] ?? null;

    if (existingUser !== null) {
      // (b) Check existing membership.
      const existingMembership = await tx
        .select()
        .from(memberships)
        .where(
          and(eq(memberships.user_id, existingUser.id), eq(memberships.semester_id, semesterId)),
        )
        .limit(1);

      if (existingMembership.length > 0) {
        throw Errors.memberAlready(existingUser.id, semesterId);
      }

      // (c) Insert membership directly.
      const inviter = await tx
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, invitedBy))
        .limit(1);
      const inviterEmail = inviter[0]?.email ?? invitedBy;

      const inserted = await tx
        .insert(memberships)
        .values({
          user_id: existingUser.id,
          semester_id: semesterId,
          role,
          granted_by: invitedBy,
        })
        .returning();

      const row = inserted[0]!;
      return {
        kind: 'member' as const,
        member: {
          user_id: existingUser.id,
          email: existingUser.email,
          display_name: existingUser.display_name,
          role: row.role as Role,
          granted_at: row.granted_at.toISOString(),
          granted_by_email: inviterEmail,
        },
      };
    }

    // (d) No existing user — insert pending_invitations row.
    // The partial unique index prevents duplicate open invitations.
    const inviter = await tx
      .select({ email: users.email, display_name: users.display_name })
      .from(users)
      .where(eq(users.id, invitedBy))
      .limit(1);
    const inviterEmail = inviter[0]?.email ?? invitedBy;
    const inviterDisplayName = inviter[0]?.display_name ?? inviterEmail;

    let pendingRow: typeof pending_invitations.$inferSelect;
    try {
      const rows = await tx
        .insert(pending_invitations)
        .values({
          email: normalizedEmail,
          semester_id: semesterId,
          role,
          invited_by: invitedBy,
        })
        .returning();
      pendingRow = rows[0]!;
    } catch (err) {
      if (isUniqueConstraintViolation(err)) {
        throw Errors.invitationAlreadyOpen(email, semesterId);
      }
      throw err;
    }

    const pending: PendingSummary = {
      id: pendingRow.id,
      email: pendingRow.email,
      role: pendingRow.role as Role,
      invited_at: pendingRow.created_at.toISOString(),
      invited_by_email: inviterEmail,
    };

    // Stash the pending email address so we can call sendEmail after the TX.
    // The route builds the full email template (with course/semester slugs) and
    // passes a pre-baked sendEmail closure that already has content.
    // We store the recipient so we can call deps.sendEmail({ to, ... }).
    emailSendArgs = {
      to: normalizedEmail,
      // subject/text/html come from the route's pre-built closure; the service
      // passes them through. When the route injects deps.sendEmail as a closure
      // that ignores these fields and uses pre-built content, they're irrelevant.
      // When tests inject a vi.fn(), the spy captures these values for assertion.
      subject: '',
      text: '',
      html: '',
      pendingSummary: pending,
    };

    return { kind: 'pending' as const, pending };
  });

  // Fire-and-forget email send outside transaction.
  // deps.sendEmail is injected by the route, which wraps the real transport in
  // a closure that already has course/semester slug context baked in.
  // We call it with { to } only; the closure rebuilds the full content.
  if (result.kind === 'pending' && deps.sendEmail !== undefined && emailSendArgs !== undefined) {
    deps.sendEmail({
      to: emailSendArgs.to,
      subject: emailSendArgs.subject,
      text: emailSendArgs.text,
      html: emailSendArgs.html,
    }).catch(() => {
      // Email sending failures are non-fatal. The pending row is already created.
      // In production, a failed send is logged by the transport layer.
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// activatePendingInvitations
// ---------------------------------------------------------------------------

/**
 * Activate all open pending invitations for a given verified email address.
 *
 * Must be called in the SAME transaction as the user-create operation.
 * Idempotent: only activates rows where consumed_at IS NULL.
 *
 * For each pending_invitation row:
 *   1. Insert a memberships row (user_id, semester_id, role, granted_by=invited_by).
 *   2. Set consumed_at = now().
 *
 * On membership conflict (user already a member somehow): skip silently.
 *
 * Returns { activated: number } — the count of invitations activated.
 */
export async function activatePendingInvitations(
  db: DrizzleDb,
  verifiedEmail: string,
  userId: UUID,
): Promise<{ activated: number }> {
  const normalizedEmail = verifiedEmail.toLowerCase();

  // Find all open invitations for this email.
  const openInvitations = await db
    .select()
    .from(pending_invitations)
    .where(
      and(
        sql`LOWER(${pending_invitations.email}) = ${normalizedEmail}`,
        isNull(pending_invitations.consumed_at),
      ),
    );

  if (openInvitations.length === 0) {
    return { activated: 0 };
  }

  let activated = 0;

  for (const invitation of openInvitations) {
    try {
      await db
        .insert(memberships)
        .values({
          user_id: userId,
          semester_id: invitation.semester_id,
          role: invitation.role,
          granted_by: invitation.invited_by,
        })
        .onConflictDoNothing(); // Skip if already a member (idempotent).

      // Mark invitation as consumed.
      await db
        .update(pending_invitations)
        .set({ consumed_at: new Date() })
        .where(eq(pending_invitations.id, invitation.id));

      activated++;
    } catch {
      // Non-fatal: log and continue. A failed activation should not block login.
      // The next login attempt will retry (consumed_at is still NULL).
    }
  }

  return { activated };
}

// ---------------------------------------------------------------------------
// revokeInvitation
// ---------------------------------------------------------------------------

/**
 * Hard-delete a pending_invitations row.
 *
 * Idempotent: deleting a non-existent row is a no-op (not an error).
 * Consumed invitations can also be revoked (their `consumed_at IS NOT NULL`)
 * — this is intentional since the route spec says hard delete.
 */
export async function revokeInvitation(db: DrizzleDb, invitationId: UUID): Promise<void> {
  await db.delete(pending_invitations).where(eq(pending_invitations.id, invitationId));
}

// ---------------------------------------------------------------------------
// listMembers / listPending (used by the GET /members endpoint)
// ---------------------------------------------------------------------------

/**
 * List all members of a semester with their granted_by email.
 */
export async function listMembers(db: DrizzleDb, semesterId: UUID): Promise<MemberSummary[]> {
  const rows = await db
    .select({
      user_id: memberships.user_id,
      email: users.email,
      display_name: users.display_name,
      role: memberships.role,
      granted_at: memberships.granted_at,
      granted_by: memberships.granted_by,
    })
    .from(memberships)
    .innerJoin(users, eq(memberships.user_id, users.id))
    .where(eq(memberships.semester_id, semesterId));

  // Fetch granted_by emails in a second query to avoid a complex join.
  const granterIds = [...new Set(rows.map((r) => r.granted_by))];
  const granters =
    granterIds.length > 0
      ? await db
          .select({ id: users.id, email: users.email })
          .from(users)
          .where(inArray(users.id, granterIds))
      : [];
  const granterEmailMap = Object.fromEntries(granters.map((g) => [g.id, g.email]));

  return rows.map((r) => ({
    user_id: r.user_id,
    email: r.email,
    display_name: r.display_name,
    role: r.role as Role,
    granted_at: r.granted_at.toISOString(),
    granted_by_email: granterEmailMap[r.granted_by] ?? r.granted_by,
  }));
}

/**
 * List all open pending invitations for a semester.
 */
export async function listPendingInvitations(
  db: DrizzleDb,
  semesterId: UUID,
): Promise<PendingSummary[]> {
  const rows = await db
    .select({
      id: pending_invitations.id,
      email: pending_invitations.email,
      role: pending_invitations.role,
      created_at: pending_invitations.created_at,
      invited_by: pending_invitations.invited_by,
    })
    .from(pending_invitations)
    .where(
      and(eq(pending_invitations.semester_id, semesterId), isNull(pending_invitations.consumed_at)),
    );

  // Fetch invited_by emails.
  const inviterIds = [...new Set(rows.map((r) => r.invited_by))];
  const inviters =
    inviterIds.length > 0
      ? await db
          .select({ id: users.id, email: users.email })
          .from(users)
          .where(inArray(users.id, inviterIds))
      : [];
  const inviterEmailMap = Object.fromEntries(inviters.map((i) => [i.id, i.email]));

  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    role: r.role as Role,
    invited_at: r.created_at.toISOString(),
    invited_by_email: inviterEmailMap[r.invited_by] ?? r.invited_by,
  }));
}

// ---------------------------------------------------------------------------
// Membership admin helpers (for PATCH + DELETE member routes)
// ---------------------------------------------------------------------------

/**
 * Count the number of admins in a semester.
 */
export async function countAdmins(db: DrizzleDb, semesterId: UUID): Promise<number> {
  const rows = await db
    .select()
    .from(memberships)
    .where(and(eq(memberships.semester_id, semesterId), eq(memberships.role, 'admin')));
  return rows.length;
}

/**
 * Get a single membership row.
 */
export async function getMembership(
  db: DrizzleDb,
  semesterId: UUID,
  userId: UUID,
): Promise<typeof memberships.$inferSelect | null> {
  const rows = await db
    .select()
    .from(memberships)
    .where(and(eq(memberships.user_id, userId), eq(memberships.semester_id, semesterId)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Update a membership's role.
 */
export async function updateMemberRole(
  db: DrizzleDb,
  semesterId: UUID,
  userId: UUID,
  role: Role,
): Promise<void> {
  await db
    .update(memberships)
    .set({ role })
    .where(and(eq(memberships.user_id, userId), eq(memberships.semester_id, semesterId)));
}

/**
 * Remove a membership (hard delete).
 */
export async function removeMember(
  db: DrizzleDb,
  semesterId: UUID,
  userId: UUID,
): Promise<void> {
  await db
    .delete(memberships)
    .where(and(eq(memberships.user_id, userId), eq(memberships.semester_id, semesterId)));
}
