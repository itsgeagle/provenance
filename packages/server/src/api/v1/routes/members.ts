/**
 * Members + invitations routes (PRD §8.3).
 *
 * GET    /semesters/:semesterId/members              — list members + pending
 * POST   /semesters/:semesterId/members              — invite member
 * PATCH  /semesters/:semesterId/members/:userId      — update member role
 * DELETE /semesters/:semesterId/members/:userId      — remove member
 * DELETE /semesters/:semesterId/invitations/:invitationId — revoke invitation
 *
 * Auth:
 *   GET    — semester member (read)
 *   POST   — semester admin (write)
 *   PATCH  — semester admin (write)
 *   DELETE member  — semester admin (write)
 *   DELETE invite  — semester admin (write)
 *
 * Rate: read.detail for GET; write.misc for all writes.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '../../../db/client.js';
import { getConfig } from '../../../config/index.js';
import { requireAuth } from '../../middleware/authorize.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import { audit } from '../../middleware/audit.js';
import { Errors, Warnings } from '../errors.js';
import * as invitationsService from '../../../services/invitations.js';
import { buildInvitationEmail } from '../../../email/templates/invitation.js';
import { getRealEmailTransport } from '../../../email/transport.js';
import type { SendEmailFn } from '../../../email/transport.js';
import { semesters, courses, users } from '../../../db/schema.js';
import { eq } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Request / response schemas
// ---------------------------------------------------------------------------

const inviteBodySchema = z.object({
  email: z.string().email(),
  role: z.enum(['admin', 'grader']),
});

const updateRoleBodySchema = z.object({
  role: z.enum(['admin', 'grader']),
});

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

/**
 * Deps are injected for testability (sendEmail override).
 * Production: call createMembersRouter() with no args.
 * Tests: call createMembersRouter({ sendEmail: vi.fn() }) to intercept emails.
 */
export interface MembersRouterDeps {
  sendEmail?: SendEmailFn;
}

export function createMembersRouter(deps: MembersRouterDeps = {}): Hono {
  const router = new Hono();

  // -------------------------------------------------------------------------
  // GET /semesters/:semesterId/members — list members + pending
  // -------------------------------------------------------------------------

  router.get(
    '/semesters/:semesterId/members',
    rateLimit('read.detail'),
    requireAuth({
      action: 'read',
      target: (c) => ({ semesterId: c.req.param('semesterId')! }),
    }),
    async (c) => {
      const semesterId = c.req.param('semesterId')!;
      const db = getDb();

      const [memberList, pendingList] = await Promise.all([
        invitationsService.listMembers(db, semesterId),
        invitationsService.listPendingInvitations(db, semesterId),
      ]);

      return c.json({ members: memberList, pending: pendingList });
    },
  );

  // -------------------------------------------------------------------------
  // POST /semesters/:semesterId/members — invite
  // -------------------------------------------------------------------------

  router.post(
    '/semesters/:semesterId/members',
    rateLimit('write.misc'),
    requireAuth({
      action: 'write',
      target: (c) => ({ semesterId: c.req.param('semesterId')! }),
    }),
    audit('member.invite', 'semester', (c) => c.req.param('semesterId')!),
    async (c) => {
      const semesterId = c.req.param('semesterId')!;
      const principal = c.var.principal!;
      const db = getDb();
      const cfg = getConfig();

      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json(Errors.validation([{ error: 'Invalid JSON' }]).toBody(), 400);
      }

      const parseResult = inviteBodySchema.safeParse(body);
      if (!parseResult.success) {
        return c.json(Errors.validation(parseResult.error.issues).toBody(), 400);
      }

      const { email, role } = parseResult.data;

      // Domain warning check (non-blocking).
      const emailDomain = email.split('@')[1] ?? '';
      const domainAllowed = cfg.AUTH_ALLOWED_HOSTED_DOMAINS.includes(emailDomain);

      // Resolve semester context for email template.
      const semesterRows = await db
        .select({
          slug: semesters.slug,
          course_id: semesters.course_id,
        })
        .from(semesters)
        .where(eq(semesters.id, semesterId))
        .limit(1);

      if (semesterRows.length === 0) {
        throw Errors.notFound();
      }
      const semesterSlug = semesterRows[0]!.slug;

      const courseRows = await db
        .select({ slug: courses.slug })
        .from(courses)
        .where(eq(courses.id, semesterRows[0]!.course_id))
        .limit(1);
      const courseSlug = courseRows[0]?.slug ?? semesterRows[0]!.course_id;

      // Resolve inviter display name for email template.
      const inviterRows = await db
        .select({ display_name: users.display_name, email: users.email })
        .from(users)
        .where(eq(users.id, principal.user.id))
        .limit(1);
      const inviterName =
        inviterRows[0]?.display_name || inviterRows[0]?.email || principal.user.id;

      // Build email content now (before service call) so we have course/semester context.
      const loginUrl = `${cfg.PUBLIC_BASE_URL}/login`;
      const emailContent = buildInvitationEmail({
        recipientEmail: email.toLowerCase(),
        invitedBy: inviterName,
        courseSlug,
        semesterSlug,
        role,
        loginUrl,
      });

      // Resolve transport: use injected dep (tests) or real transport (production).
      const transport = deps.sendEmail ?? getRealEmailTransport(cfg);

      // Build a SendEmailFn closure that uses the pre-built template content.
      // The service calls this with `{ to }` from its side; we ignore those
      // values and use the template content baked in here.
      const sendEmailForInvite: SendEmailFn = async (_args) => {
        await transport({
          to: email.toLowerCase(),
          subject: emailContent.subject,
          text: emailContent.text,
          html: emailContent.html,
        });
      };

      const result = await invitationsService.inviteMember(
        db,
        semesterId,
        email,
        role,
        principal.user.id,
        { sendEmail: sendEmailForInvite },
      );

      const responseBody: Record<string, unknown> = {};

      if (result.kind === 'member') {
        responseBody['member'] = result.member;
      } else {
        responseBody['pending'] = result.pending;
      }

      if (!domainAllowed) {
        responseBody['warning'] = Warnings.emailDomainNotAllowed(email).warning;
      }

      return c.json(responseBody, 201);
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /semesters/:semesterId/members/:userId — update role
  // -------------------------------------------------------------------------

  router.patch(
    '/semesters/:semesterId/members/:userId',
    rateLimit('write.misc'),
    requireAuth({
      action: 'write',
      target: (c) => ({ semesterId: c.req.param('semesterId')! }),
    }),
    audit('member.update', 'user', (c) => c.req.param('userId')!),
    async (c) => {
      const semesterId = c.req.param('semesterId')!;
      const userId = c.req.param('userId')!;
      const principal = c.var.principal!;
      const db = getDb();

      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json(Errors.validation([{ error: 'Invalid JSON' }]).toBody(), 400);
      }

      const parseResult = updateRoleBodySchema.safeParse(body);
      if (!parseResult.success) {
        return c.json(Errors.validation(parseResult.error.issues).toBody(), 400);
      }

      const { role: newRole } = parseResult.data;

      // Check: demoting self when self is the target.
      // Self-promotion (grader → admin) is allowed.
      // We block only: principal === target AND new role < current role.
      const isSelf = principal.user.id === userId;
      if (isSelf && newRole === 'grader') {
        // The requesting principal is trying to demote themselves.
        throw Errors.cannotDemoteSelf();
      }

      // Fetch current membership.
      const existing = await invitationsService.getMembership(db, semesterId, userId);
      if (existing === null) {
        throw Errors.notFound();
      }

      // Last-admin guard: if target is an admin and new role is grader, ensure
      // there will be at least one admin left after the update.
      if (existing.role === 'admin' && newRole === 'grader') {
        const adminCount = await invitationsService.countAdmins(db, semesterId);
        if (adminCount <= 1) {
          throw Errors.lastAdminRequired();
        }
      }

      await invitationsService.updateMemberRole(db, semesterId, userId, newRole);

      return c.json({ user_id: userId, role: newRole });
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /semesters/:semesterId/members/:userId — remove member
  //
  // Note: Self-removal is allowed for non-last-admin members (PRD §8.3).
  // The last-admin guard blocks removal of the sole admin regardless of self.
  // -------------------------------------------------------------------------

  router.delete(
    '/semesters/:semesterId/members/:userId',
    rateLimit('write.misc'),
    requireAuth({
      action: 'write',
      target: (c) => ({ semesterId: c.req.param('semesterId')! }),
    }),
    audit('member.remove', 'user', (c) => c.req.param('userId')!),
    async (c) => {
      const semesterId = c.req.param('semesterId')!;
      const userId = c.req.param('userId')!;
      const db = getDb();

      // Fetch current membership.
      const existing = await invitationsService.getMembership(db, semesterId, userId);
      if (existing === null) {
        // Member not found — idempotent, return 204.
        return c.body(null, 204);
      }

      // Last-admin guard.
      if (existing.role === 'admin') {
        const adminCount = await invitationsService.countAdmins(db, semesterId);
        if (adminCount <= 1) {
          throw Errors.lastAdminRequired();
        }
      }

      await invitationsService.removeMember(db, semesterId, userId);

      return c.body(null, 204);
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /semesters/:semesterId/invitations/:invitationId — revoke invitation
  // -------------------------------------------------------------------------

  router.delete(
    '/semesters/:semesterId/invitations/:invitationId',
    rateLimit('write.misc'),
    requireAuth({
      action: 'write',
      target: (c) => ({ semesterId: c.req.param('semesterId')! }),
    }),
    audit('invitation.revoke', 'invitation', (c) => c.req.param('invitationId')!),
    async (c) => {
      const invitationId = c.req.param('invitationId')!;
      const db = getDb();

      // Hard delete (idempotent — no error if already gone).
      await invitationsService.revokeInvitation(db, invitationId);

      return c.body(null, 204);
    },
  );

  return router;
}
