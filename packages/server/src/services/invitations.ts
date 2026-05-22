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
  const txResult = await withTransaction(db, async (tx) => {
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
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, invitedBy))
      .limit(1);
    const inviterEmail = inviter[0]?.email ?? invitedBy;

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
  if (txResult.kind === 'pending' && deps.sendEmail !== undefined && emailSendArgs !== undefined) {
    deps
      .sendEmail({
        to: emailSendArgs.to,
        subject: emailSendArgs.subject,
        text: emailSendArgs.text,
        html: emailSendArgs.html,
      })
      .catch(() => {
        // Email sending failures are non-fatal. The pending row is already created.
        // In production, a failed send is logged by the transport layer.
      });
  }

  return txResult;
}

// ---------------------------------------------------------------------------
// activatePendingInvitations
// ---------------------------------------------------------------------------

/**
 * Activate all open pending invitations for a given verified email address.
 *
 * Must be called in the SAME transaction as the user-create operation (auth.ts
 * passes `tx` here so the user-create and invitation-consume are atomic).
 * Idempotent: only activates rows where consumed_at IS NULL.
 *
 * Implementation: a single CTE executes the INSERT into memberships and the
 * UPDATE of consumed_at atomically. If the server crashes between the two
 * statements in the old for-loop approach, the DB would be left in an
 * inconsistent state (membership inserted, consumed_at still NULL). The CTE
 * collapses this to one round-trip with no intermediate state:
 *
 *   WITH ins AS (
 *     INSERT INTO memberships (user_id, semester_id, role, granted_by)
 *     SELECT $userId, semester_id, role, invited_by
 *     FROM pending_invitations
 *     WHERE LOWER(email) = $email AND consumed_at IS NULL
 *     ON CONFLICT (user_id, semester_id) DO NOTHING
 *     RETURNING semester_id
 *   )
 *   UPDATE pending_invitations
 *   SET consumed_at = now()
 *   WHERE LOWER(email) = $email
 *     AND consumed_at IS NULL
 *     AND semester_id IN (SELECT semester_id FROM ins);
 *
 * The UPDATE's WHERE ... IN (SELECT semester_id FROM ins) means: only mark
 * rows consumed when the INSERT actually produced a new membership (ON CONFLICT
 * DO NOTHING means conflict rows do NOT appear in RETURNING, so already-member
 * invitations are not consumed again, preserving idempotency).
 *
 * On membership conflict (user already a member somehow): the invitation row is
 * left unconsumed — this matches the idempotency contract. A second call will
 * still see consumed_at IS NULL but the INSERT will conflict again, so the
 * UPDATE won't fire, and the count will be 0.
 *
 * Returns { activated: number } — the count of invitation rows marked consumed.
 *
 * Error handling: any DB error propagates to the caller. auth.ts wraps this
 * call inside withTransaction; an error here will roll back the whole
 * login transaction, causing the user to see a 502 and retry. This is safer
 * than swallowing errors and leaving half-activated state.
 */
export async function activatePendingInvitations(
  db: DrizzleDb,
  verifiedEmail: string,
  userId: UUID,
): Promise<{ activated: number }> {
  const normalizedEmail = verifiedEmail.toLowerCase();

  // Single atomic CTE: INSERT memberships + UPDATE consumed_at.
  // Using db.execute(sql`...`) because Drizzle's typed builder does not support
  // CTE-based UPDATE...WHERE...IN(SELECT...) in a single chainable expression
  // without significant indirection. Raw sql`` with parameter binding is safe
  // against SQL injection — the sql tagged template escapes all interpolated
  // values via the postgres.js placeholder mechanism.
  const result = await db.execute(
    sql`
      WITH ins AS (
        INSERT INTO memberships (user_id, semester_id, role, granted_by)
        SELECT ${userId}::uuid, semester_id, role, invited_by
        FROM pending_invitations
        WHERE LOWER(email) = ${normalizedEmail}
          AND consumed_at IS NULL
        ON CONFLICT (user_id, semester_id) DO NOTHING
        RETURNING semester_id
      )
      UPDATE pending_invitations
      SET consumed_at = now()
      WHERE LOWER(email) = ${normalizedEmail}
        AND consumed_at IS NULL
        AND semester_id IN (SELECT semester_id FROM ins)
    `,
  );

  // postgres.js returns { count: bigint } on UPDATE; the count is the number of
  // pending_invitations rows whose consumed_at was just set.
  const activated = Number(result.count ?? 0);
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
 * Count the number of admins in a semester using a SQL aggregate.
 *
 * NOTE: After the Critical-2 fix, the serialized PATCH/DELETE helpers
 * (`updateMemberRoleSafely`, `removeMemberSafely`) lock + count admins inside
 * a transaction instead of calling this function. `countAdmins` is kept for
 * any future callers that need a non-locking read.
 */
export async function countAdmins(db: DrizzleDb, semesterId: UUID): Promise<number> {
  const result = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(memberships)
    .where(and(eq(memberships.semester_id, semesterId), eq(memberships.role, 'admin')));
  return result[0]?.count ?? 0;
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
 * @deprecated Use `updateMemberRoleSafely` from route handlers to get the
 *   last-admin guard + row locks. This bare function is kept for tests that
 *   need to set up state without going through the guard.
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
 * @deprecated Use `removeMemberSafely` from route handlers to get the
 *   last-admin guard + row locks.
 */
export async function removeMember(db: DrizzleDb, semesterId: UUID, userId: UUID): Promise<void> {
  await db
    .delete(memberships)
    .where(and(eq(memberships.user_id, userId), eq(memberships.semester_id, semesterId)));
}

// ---------------------------------------------------------------------------
// Safe (locking) PATCH / DELETE helpers — Critical 2 fix
// ---------------------------------------------------------------------------

/**
 * Update a membership's role with a last-admin guard and explicit row locks.
 *
 * Concurrency problem being solved:
 * Two admins concurrently demoting each other both see countAdmins() === 2,
 * both pass the guard, and both update — leaving 0 admins. The TOCTOU window
 * is eliminated by wrapping the check+mutate in a transaction that holds
 * FOR UPDATE locks on all admin rows for the semester. Postgres serializes
 * concurrent transactions on the same locked rows, so only one wins.
 *
 * Lock order:
 *   1. Lock the target membership row (FOR UPDATE).
 *   2. Lock all admin rows for the semester (FOR UPDATE) — needed so that a
 *      concurrent demote of a different admin row cannot sneak through while
 *      this transaction's admin count read is still valid.
 *
 * Returns the updated row's new role.
 * Throws:
 *   - Errors.notFound()          if the target membership doesn't exist.
 *   - Errors.lastAdminRequired() if demoting the sole admin.
 */
export async function updateMemberRoleSafely(
  db: DrizzleDb,
  semesterId: UUID,
  userId: UUID,
  newRole: Role,
): Promise<void> {
  await withTransaction(db, async (tx) => {
    // 1. Lock the target row.
    const targetRows = await tx
      .select()
      .from(memberships)
      .where(and(eq(memberships.user_id, userId), eq(memberships.semester_id, semesterId)))
      .for('update')
      .limit(1);

    if (targetRows.length === 0) {
      throw Errors.notFound();
    }
    const target = targetRows[0]!;

    // 2. If demoting an admin, lock ALL admin rows and count them.
    //    Locking all admin rows prevents a concurrent demote of any admin from
    //    slipping through between our count and our update.
    if (target.role === 'admin' && newRole === 'grader') {
      const adminRows = await tx
        .select({ user_id: memberships.user_id })
        .from(memberships)
        .where(and(eq(memberships.semester_id, semesterId), eq(memberships.role, 'admin')))
        .for('update');

      if (adminRows.length <= 1) {
        throw Errors.lastAdminRequired();
      }
    }

    // 3. Apply the update.
    await tx
      .update(memberships)
      .set({ role: newRole })
      .where(and(eq(memberships.user_id, userId), eq(memberships.semester_id, semesterId)));
  });
}

/**
 * Remove a membership with a last-admin guard and explicit row locks.
 *
 * Same concurrency pattern as `updateMemberRoleSafely`.
 *
 * Returns `'removed'` when the member was deleted, or `'not_found'` when the
 * membership didn't exist (idempotent — callers should return 204 either way).
 * Throws Errors.lastAdminRequired() if attempting to remove the sole admin.
 */
export async function removeMemberSafely(
  db: DrizzleDb,
  semesterId: UUID,
  userId: UUID,
): Promise<'removed' | 'not_found'> {
  return withTransaction(db, async (tx) => {
    // 1. Lock the target row.
    const targetRows = await tx
      .select()
      .from(memberships)
      .where(and(eq(memberships.user_id, userId), eq(memberships.semester_id, semesterId)))
      .for('update')
      .limit(1);

    if (targetRows.length === 0) {
      return 'not_found';
    }
    const target = targetRows[0]!;

    // 2. If removing an admin, lock ALL admin rows and count them.
    if (target.role === 'admin') {
      const adminRows = await tx
        .select({ user_id: memberships.user_id })
        .from(memberships)
        .where(and(eq(memberships.semester_id, semesterId), eq(memberships.role, 'admin')))
        .for('update');

      if (adminRows.length <= 1) {
        throw Errors.lastAdminRequired();
      }
    }

    // 3. Apply the delete.
    await tx
      .delete(memberships)
      .where(and(eq(memberships.user_id, userId), eq(memberships.semester_id, semesterId)));

    return 'removed';
  });
}
