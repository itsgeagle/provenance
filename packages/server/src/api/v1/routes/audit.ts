/**
 * Audit log route — Phase 19 (PRD §8.13).
 *
 * GET /api/v1/audit
 *
 * Auth: semester admin (sees their semesters) OR superadmin (sees all).
 * Non-admins receive 403.
 *
 * Query params:
 *   semester_id?     — filter to a specific semester (admin must own it)
 *   actor_user_id?   — filter to a specific actor
 *   action?          — exact action string filter
 *   since?           — ISO date lower bound (inclusive)
 *   until?           — ISO date upper bound (inclusive)
 *   cursor?          — base64-encoded JSON { at: string, id: number }
 *   limit?           — default 50, max 200
 *
 * Sort: created_at DESC, id DESC.
 * Cursor: (at, id) tuple encoded as base64(JSON).
 *
 * Rate: read.detail — audit reads are expensive but not bulk-data.
 */

import { Hono } from 'hono';
import { and, eq, lte, gte, lt, or } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { getDb } from '../../../db/client.js';
import { audit_log, memberships } from '../../../db/schema.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import { Errors } from '../errors.js';
import type { Principal } from '../../middleware/auth-session.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AuditCursor {
  at: number; // Unix timestamp in milliseconds (numeric epoch for precision)
  id: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function encodeCursor(at: Date, id: number): string {
  const payload: AuditCursor = { at: at.getTime(), id };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function decodeCursor(raw: string): AuditCursor | null {
  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf-8');
    const parsed: unknown = JSON.parse(decoded);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'at' in parsed &&
      'id' in parsed &&
      typeof (parsed as Record<string, unknown>).at === 'number' &&
      typeof (parsed as Record<string, unknown>).id === 'number'
    ) {
      return parsed as AuditCursor;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Returns the set of semester_ids the principal admins, or null if superadmin.
 *
 * Returns:
 *   null  — superadmin, can see everything
 *   UUID[]  — list of semester_ids where role = 'admin'
 *   []    — no admin semesters (will result in empty response)
 */
async function getAdminSemesterIds(
  db: ReturnType<typeof getDb>,
  principal: Principal,
): Promise<string[] | null> {
  if (principal.user.is_superadmin) {
    return null; // superadmin: no filter
  }

  const rows = await db
    .select({ semester_id: memberships.semester_id })
    .from(memberships)
    .where(and(eq(memberships.user_id, principal.user.id), eq(memberships.role, 'admin')));

  return rows.map((r) => r.semester_id);
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createAuditRouter(): Hono {
  const router = new Hono();

  // -------------------------------------------------------------------------
  // GET /audit
  // -------------------------------------------------------------------------

  router.get('/audit', rateLimit('read.detail'), async (c) => {
    const principal = c.var.principal ?? null;

    // Auth check
    if (principal === null) {
      const returnTo = encodeURIComponent(c.req.path);
      return c.json(
        Errors.authRequired(`/api/v1/auth/google/start?return_to=${returnTo}`).toBody(),
        401,
      );
    }

    const db = getDb();

    // Resolve admin semester scope
    const adminSemesterIds = await getAdminSemesterIds(db, principal);

    // If not superadmin and has no admin semesters, return 403.
    if (adminSemesterIds !== null && adminSemesterIds.length === 0) {
      return c.json(Errors.insufficientRole('admin').toBody(), 403);
    }

    // Parse query params
    const semesterIdFilter = c.req.query('semester_id') ?? null;
    const actorUserIdFilter = c.req.query('actor_user_id') ?? null;
    const actionFilter = c.req.query('action') ?? null;
    const sinceRaw = c.req.query('since') ?? null;
    const untilRaw = c.req.query('until') ?? null;
    const cursorRaw = c.req.query('cursor') ?? null;
    const limitRaw = c.req.query('limit') ?? null;

    // Validate limit
    const limitParsed = limitRaw !== null ? parseInt(limitRaw, 10) : DEFAULT_LIMIT;
    if (isNaN(limitParsed) || limitParsed < 1 || limitParsed > MAX_LIMIT) {
      return c.json(
        Errors.validation([{ field: 'limit', issue: `Must be 1–${MAX_LIMIT}` }]).toBody(),
        400,
      );
    }
    const limit = limitParsed;

    // Validate since/until
    let sinceDate: Date | null = null;
    let untilDate: Date | null = null;
    if (sinceRaw !== null) {
      sinceDate = new Date(sinceRaw);
      if (isNaN(sinceDate.getTime())) {
        return c.json(
          Errors.validation([{ field: 'since', issue: 'Invalid ISO date' }]).toBody(),
          400,
        );
      }
    }
    if (untilRaw !== null) {
      untilDate = new Date(untilRaw);
      if (isNaN(untilDate.getTime())) {
        return c.json(
          Errors.validation([{ field: 'until', issue: 'Invalid ISO date' }]).toBody(),
          400,
        );
      }
    }

    // If semester admin and semester_id filter specified, validate they own that semester
    if (semesterIdFilter !== null && adminSemesterIds !== null) {
      if (!adminSemesterIds.includes(semesterIdFilter)) {
        return c.json(Errors.insufficientRole('admin').toBody(), 403);
      }
    }

    // Determine effective semester filter
    // Superadmin: use semesterIdFilter if provided, else no filter
    // Semester admin: use semesterIdFilter if provided, else filter to their admin semesters
    let effectiveSemesterIds: string[] | null = null;
    if (adminSemesterIds !== null) {
      // Semester admin
      effectiveSemesterIds = semesterIdFilter !== null ? [semesterIdFilter] : adminSemesterIds;
    } else if (semesterIdFilter !== null) {
      // Superadmin with explicit filter
      effectiveSemesterIds = [semesterIdFilter];
    }
    // Superadmin with no filter: effectiveSemesterIds stays null (no filter)

    // Decode cursor
    const cursor: AuditCursor | null = cursorRaw !== null ? decodeCursor(cursorRaw) : null;
    if (cursorRaw !== null && cursor === null) {
      return c.json(
        Errors.validation([{ field: 'cursor', issue: 'Invalid cursor' }]).toBody(),
        400,
      );
    }

    // Build WHERE conditions using Drizzle's typed API
    // We build the query via sql template for the semester IN clause (Drizzle
    // doesn't support dynamic IN well with null guards), and typed API for the rest.

    type WhereCondition = ReturnType<typeof eq>;

    const conditions: WhereCondition[] = [];

    if (actorUserIdFilter !== null) {
      conditions.push(eq(audit_log.actor_user_id, actorUserIdFilter));
    }
    if (actionFilter !== null) {
      conditions.push(eq(audit_log.action, actionFilter));
    }
    if (sinceDate !== null) {
      conditions.push(gte(audit_log.at, sinceDate));
    }
    if (untilDate !== null) {
      conditions.push(lte(audit_log.at, untilDate));
    }

    // Cursor condition (DESC pagination):
    // Rows before the cursor are those with:
    //   (at < T_this_ms) OR (at <= T_this_ms AND id < cursor.id)
    // where T_this_ms is cursor.at. To handle ms-precision boundaries,
    // we use the numeric epoch directly, avoiding ISO string round-trip
    // truncation (V33-style fix).
    if (cursor !== null) {
      const cursorAtMs = cursor.at;
      const cursorAtDate = new Date(cursorAtMs);
      conditions.push(
        or(
          lt(audit_log.at, cursorAtDate),
          and(eq(audit_log.at, cursorAtDate), lt(audit_log.id, cursor.id)),
        ) as WhereCondition,
      );
    }

    // Semester filter
    if (effectiveSemesterIds !== null) {
      if (effectiveSemesterIds.length === 0) {
        // No accessible semesters → empty result
        return c.json({ items: [], next_cursor: null });
      }
      // Use sql template for IN with typed UUIDs
      const semIds = effectiveSemesterIds;
      conditions.push(
        sql`${audit_log.semester_id} IN (${sql.join(
          semIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})` as unknown as WhereCondition,
      );
    }

    const rows = await db
      .select({
        id: audit_log.id,
        actor_user_id: audit_log.actor_user_id,
        actor_token_id: audit_log.actor_token_id,
        action: audit_log.action,
        target_type: audit_log.target_type,
        target_id: audit_log.target_id,
        semester_id: audit_log.semester_id,
        detail: audit_log.detail,
        at: audit_log.at,
      })
      .from(audit_log)
      .where(and(...conditions))
      .orderBy(sql`${audit_log.at} DESC, ${audit_log.id} DESC`)
      .limit(limit + 1); // fetch one extra to detect next page

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;

    let nextCursor: string | null = null;
    if (hasMore && items.length > 0) {
      const last = items[items.length - 1]!;
      nextCursor = encodeCursor(last.at, last.id);
    }

    return c.json({
      items: items.map((r) => ({
        id: r.id,
        actor_user_id: r.actor_user_id ?? null,
        actor_token_id: r.actor_token_id ?? null,
        action: r.action,
        target_type: r.target_type,
        target_id: r.target_id,
        semester_id: r.semester_id ?? null,
        detail: r.detail,
        at: r.at.toISOString(),
      })),
      next_cursor: nextCursor,
    });
  });

  return router;
}
