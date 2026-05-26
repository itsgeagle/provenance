/**
 * V45 — Superadmin-only management routes.
 *
 * All routes are gated by `requireAuth({ action: 'admin', target: 'global' })`
 * which enforces:
 *   - Authenticated principal (401 otherwise).
 *   - principal.user.is_superadmin === true (403 otherwise).
 *   - View-as blocks any non-read action (so a superadmin already
 *     impersonating cannot transitively impersonate someone else).
 *
 * View-as is session-only by design. Token principals attempting the
 * view-as enter/exit endpoints get a 403 inside the handler — there is no
 * principal_kind === 'token' branch that succeeds.
 *
 * Routes:
 *   GET    /admin/users               — list users (search + cursor pagination)
 *   GET    /admin/users/:userId       — user detail with cross-semester memberships
 *   DELETE /admin/users/:userId       — hard-delete a user (cannot delete self)
 *   POST   /admin/view-as             — enter view-as mode (body: { user_id })
 *   POST   /admin/view-as/exit        — exit view-as mode
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, desc, eq, gt, ilike, or, sql, type SQL } from 'drizzle-orm';
import { getDb } from '../../../db/client.js';
import { users, memberships, semesters, courses } from '../../../db/schema.js';
import { requireAuth } from '../../middleware/authorize.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import { requirePrincipal } from '../../middleware/auth-session.js';
import { insertAuditRow } from '../../middleware/audit.js';
import { setSessionViewAs, clearSessionViewAs } from '../../../auth/sessions.js';
import { Errors } from '../errors.js';

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

const ViewAsRequestSchema = z.object({
  user_id: z.string().uuid(),
});

// ---------------------------------------------------------------------------
// Cursor (created_at desc, id desc for stable tie-break)
// ---------------------------------------------------------------------------

interface UserListCursor {
  created_at: string; // ISO
  id: string;
}

function encodeUserCursor(c: UserListCursor): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}

function decodeUserCursor(encoded: string): UserListCursor | null {
  try {
    const raw = Buffer.from(encoded, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const p = parsed as Record<string, unknown>;
    if (typeof p['created_at'] !== 'string' || typeof p['id'] !== 'string') return null;
    return { created_at: p['created_at'], id: p['id'] };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function createAdminRouter(): Hono {
  const router = new Hono();

  // ===========================================================================
  // GET /admin/users — paginated user list
  // ===========================================================================
  router.get(
    '/users',
    rateLimit('read.cohort'),
    requireAuth({ action: 'read', target: 'global' }),
    async (c) => {
      const db = getDb();

      const q = c.req.query('q')?.trim() ?? '';
      const rawLimit = parseInt(c.req.query('limit') ?? '50', 10);
      const limit = isNaN(rawLimit) || rawLimit < 1 ? 50 : rawLimit > 500 ? 500 : rawLimit;
      const cursorStr = c.req.query('cursor');
      const cursor = cursorStr !== undefined ? decodeUserCursor(cursorStr) : null;
      if (cursorStr !== undefined && cursor === null) {
        return c.json(Errors.validation([{ field: 'cursor', issue: 'invalid' }]).toBody(), 400);
      }

      const conditions: SQL[] = [];
      if (q !== '') {
        const pattern = `%${q}%`;
        const searchCondition = or(ilike(users.email, pattern), ilike(users.display_name, pattern));
        if (searchCondition !== undefined) conditions.push(searchCondition);
      }
      if (cursor !== null) {
        // (created_at, id) DESC — cursor walks forward by accepting rows
        // strictly older than the cursor row, OR same created_at with smaller id.
        const cursorDate = new Date(cursor.created_at);
        const cursorCond = sql`(${users.created_at}, ${users.id}) < (${cursorDate}, ${cursor.id})`;
        conditions.push(cursorCond);
      }

      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      const rows = await db
        .select({
          id: users.id,
          email: users.email,
          display_name: users.display_name,
          is_superadmin: users.is_superadmin,
          created_at: users.created_at,
          last_login_at: users.last_login_at,
        })
        .from(users)
        .where(whereClause)
        .orderBy(desc(users.created_at), desc(users.id))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const items = (hasMore ? rows.slice(0, limit) : rows).map((u) => ({
        id: u.id,
        email: u.email,
        display_name: u.display_name,
        is_superadmin: u.is_superadmin,
        created_at: u.created_at.toISOString(),
        last_login_at: u.last_login_at !== null ? u.last_login_at.toISOString() : null,
      }));

      const last = items[items.length - 1];
      const nextCursor =
        hasMore && last !== undefined
          ? encodeUserCursor({ created_at: last.created_at, id: last.id })
          : null;

      return c.json({ items, next_cursor: nextCursor });
    },
  );

  // ===========================================================================
  // GET /admin/users/:userId — detail + memberships
  // ===========================================================================
  router.get(
    '/users/:userId',
    rateLimit('read.detail'),
    requireAuth({ action: 'read', target: 'global' }),
    async (c) => {
      const db = getDb();
      const userId = c.req.param('userId');

      const userRows = await db
        .select()
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      const u = userRows[0];
      if (u === undefined) {
        return c.json(Errors.notFound().toBody(), 404);
      }

      const membershipRows = await db
        .select({
          semester_id: memberships.semester_id,
          semester_slug: semesters.slug,
          course_slug: courses.slug,
          role: memberships.role,
          granted_at: memberships.granted_at,
        })
        .from(memberships)
        .innerJoin(semesters, eq(memberships.semester_id, semesters.id))
        .innerJoin(courses, eq(semesters.course_id, courses.id))
        .where(eq(memberships.user_id, userId))
        .orderBy(asc(courses.slug), asc(semesters.slug));

      return c.json({
        user: {
          id: u.id,
          email: u.email,
          display_name: u.display_name,
          is_superadmin: u.is_superadmin,
          created_at: u.created_at.toISOString(),
          last_login_at: u.last_login_at !== null ? u.last_login_at.toISOString() : null,
        },
        memberships: membershipRows.map((m) => ({
          semester_id: m.semester_id,
          semester_slug: m.semester_slug,
          course_slug: m.course_slug,
          role: m.role as 'admin' | 'grader',
          granted_at: m.granted_at.toISOString(),
        })),
      });
    },
  );

  // ===========================================================================
  // DELETE /admin/users/:userId — hard delete (cannot delete self)
  // ===========================================================================
  router.delete(
    '/users/:userId',
    rateLimit('write.misc'),
    requireAuth({ action: 'admin', target: 'global' }),
    async (c) => {
      const principal = requirePrincipal(c);
      const userId = c.req.param('userId');

      if (userId === principal.user.id) {
        return c.json(
          Errors.validation([{ field: 'user_id', issue: 'cannot delete yourself' }]).toBody(),
          400,
        );
      }

      const targetRows = await db()
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      const target = targetRows[0];
      if (target === undefined) {
        return c.json(Errors.notFound().toBody(), 404);
      }

      await db().delete(users).where(eq(users.id, userId));

      // Audit (fire-and-forget — log on failure, do not block response).
      void insertAuditRow({
        actorUserId: principal.user.id,
        actorTokenId: principal.principal_kind === 'token' ? principal.token.id : null,
        semesterId: null,
        action: 'admin.user.delete',
        targetType: 'user',
        targetId: userId,
        detail: { email: target.email },
        ip: c.req.header('x-forwarded-for') ?? null,
        userAgent: c.req.header('user-agent') ?? null,
        at: new Date(),
      }).catch(() => {});

      return c.body(null, 204);
    },
  );

  // ===========================================================================
  // POST /admin/view-as — enter view-as mode
  // ===========================================================================
  router.post(
    '/view-as',
    rateLimit('write.misc'),
    requireAuth({ action: 'admin', target: 'global' }),
    async (c) => {
      const principal = requirePrincipal(c);

      // View-as is session-only. Tokens fall through to a 403 here. requireAuth
      // already rejects token principals lacking unrestricted scope on a global
      // route, but we double-check the kind to make the policy explicit.
      if (principal.principal_kind !== 'session') {
        return c.json(
          Errors.validation([
            { field: 'principal', issue: 'view-as is only available to session principals' },
          ]).toBody(),
          400,
        );
      }

      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json(Errors.validation([{ field: 'body', issue: 'invalid JSON' }]).toBody(), 400);
      }
      const parsed = ViewAsRequestSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          Errors.validation(parsed.error.issues.map((i) => ({ path: i.path, msg: i.message }))).toBody(),
          400,
        );
      }
      const targetUserId = parsed.data.user_id;

      if (targetUserId === principal.user.id) {
        return c.json(
          Errors.validation([
            { field: 'user_id', issue: 'cannot view-as yourself' },
          ]).toBody(),
          400,
        );
      }

      // Verify target exists
      const targetRows = await db()
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(eq(users.id, targetUserId))
        .limit(1);
      const target = targetRows[0];
      if (target === undefined) {
        return c.json(Errors.notFound().toBody(), 404);
      }

      await setSessionViewAs(db(), principal.session.id, targetUserId);

      void insertAuditRow({
        actorUserId: principal.user.id,
        actorTokenId: null,
        semesterId: null,
        action: 'admin.view_as.start',
        targetType: 'user',
        targetId: targetUserId,
        detail: { email: target.email },
        ip: c.req.header('x-forwarded-for') ?? null,
        userAgent: c.req.header('user-agent') ?? null,
        at: new Date(),
      }).catch(() => {});

      return c.json({ ok: true });
    },
  );

  // ===========================================================================
  // POST /admin/view-as/exit — leave view-as mode
  //
  // Bypasses the standard requireAuth pipeline because by definition the
  // caller IS in view-as (a write-action gated path would block them with
  // VIEW_AS_READ_ONLY before they could escape). Hand-rolled checks here.
  // ===========================================================================
  router.post('/view-as/exit', rateLimit('write.misc'), async (c) => {
    const principal = c.var.principal;
    if (principal === null || principal === undefined) {
      const returnTo = encodeURIComponent(c.req.path);
      return c.json(
        Errors.authRequired(`/api/v1/auth/google/start?return_to=${returnTo}`).toBody(),
        401,
      );
    }
    if (principal.principal_kind !== 'session') {
      return c.json(
        Errors.validation([
          { field: 'principal', issue: 'view-as is only available to session principals' },
        ]).toBody(),
        400,
      );
    }
    if (principal.viewAs === undefined) {
      // Not in view-as. Idempotent: 204 either way.
      return c.body(null, 204);
    }

    const targetUserId = principal.viewAs.userId;
    await clearSessionViewAs(db(), principal.session.id);

    void insertAuditRow({
      actorUserId: principal.user.id,
      actorTokenId: null,
      semesterId: null,
      action: 'admin.view_as.exit',
      targetType: 'user',
      targetId: targetUserId,
      detail: {},
      ip: c.req.header('x-forwarded-for') ?? null,
      userAgent: c.req.header('user-agent') ?? null,
      at: new Date(),
    }).catch(() => {});

    return c.body(null, 204);
  });

  return router;
}

// Local helper to keep the calls terse.
function db() {
  return getDb();
}
