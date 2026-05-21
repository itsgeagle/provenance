/**
 * Audit logging middleware (PRD §13).
 *
 * Wraps a route handler. On success (HTTP 2xx), inserts a row into `audit_log`.
 * On failure (4xx/5xx), does NOT insert — audit captures completed actions, not attempts.
 *
 * The insert is fire-and-forget: errors are logged as warnings but never propagate
 * to the response. Pattern matches the fire-and-forget used by `updateTokenLastUsed`.
 *
 * Context variables consumed:
 *   c.var.principal    — set by authSessionMiddleware
 *   c.var.target       — set by requireAuth (semester context, may be null for global routes)
 *   c.var.requestId    — set by requestId middleware
 *   c.var.auditDetail  — optional; routes set this before responding to add structured detail
 *
 * Usage:
 *   router.post('/semesters/:id/config',
 *     requireAuth({ action: 'write', target: (c) => ({ semesterId: c.req.param('id') }) }),
 *     audit('heuristic_config.commit', 'semester', (c) => c.req.param('id')),
 *     handler,
 *   );
 *
 * Routes can add structured detail by calling:
 *   c.set('auditDetail', { previous_version: 3 });
 * before returning their response.
 *
 * Context variables are declared in hono-context.d.ts.
 */

import type { Context, MiddlewareHandler } from 'hono';
import { audit_log } from '../../db/schema.js';
import { getDb } from '../../db/client.js';
import { getLogger } from '../../logging.js';

// ---------------------------------------------------------------------------
// audit middleware factory
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// AuditOptions
// ---------------------------------------------------------------------------

/**
 * Options for the audit middleware factory.
 *
 * The `onInsertComplete` callback is a test-only seam. In production it is
 * left undefined (fire-and-forget). In tests, passing a callback lets callers
 * await the in-flight insert promise before making assertions — no setTimeout
 * heuristics required.
 */
export interface AuditOptions {
  /**
   * Clock injection for tests. Defaults to `() => new Date()`.
   */
  nowFn?: () => Date;

  /**
   * @internal Test-only seam.
   *
   * When set, the audit handler calls this with the insert promise immediately
   * after firing it. Tests can capture the promise and await it before asserting
   * on DB state.
   *
   * In production, leave undefined. Fires-and-forgets as before.
   */
  onInsertComplete?: (result: Promise<void>) => void;
}

/**
 * Creates an audit middleware for a specific action.
 *
 * @param action            The action string from PRD §13.2 catalog (e.g. 'heuristic_config.commit').
 * @param targetType        The target entity type (e.g. 'semester', 'submission', 'api_token').
 * @param targetIdFromContext  Function that extracts the target entity ID from the context.
 * @param nowFnOrOptions    Either a clock function (legacy positional arg for backwards compat)
 *                          or an AuditOptions object.
 */
export function audit(
  action: string,
  targetType: string,
  targetIdFromContext: (c: Context) => string,
  nowFnOrOptions: (() => Date) | AuditOptions = () => new Date(),
): MiddlewareHandler {
  // Normalise the 4th argument — accept both the legacy `() => Date` form and
  // the new AuditOptions object so existing call-sites don't need to change.
  const nowFn =
    typeof nowFnOrOptions === 'function'
      ? nowFnOrOptions
      : (nowFnOrOptions.nowFn ?? (() => new Date()));
  const onInsertComplete =
    typeof nowFnOrOptions === 'function' ? undefined : nowFnOrOptions.onInsertComplete;

  return async (c, next) => {
    await next();

    // Only audit on success (2xx responses).
    const status = c.res.status;
    if (status < 200 || status >= 300) {
      return;
    }

    // Collect context after next() so routes can have set auditDetail.
    const principal = c.var.principal ?? null;
    const target = c.var.target ?? null;
    const detail = c.var.auditDetail ?? {};

    const actorUserId = principal !== null ? principal.user.id : null;
    const actorTokenId =
      principal !== null && principal.principal_kind === 'token' ? principal.token.id : null;
    const semesterId = target?.semesterId ?? null;

    let targetId: string;
    try {
      targetId = targetIdFromContext(c);
    } catch {
      targetId = 'unknown';
    }

    const ip = c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip') ?? null;
    const userAgent = c.req.header('user-agent') ?? null;
    const at = nowFn();

    // Fire-and-forget: never block or alter the response.
    const insertPromise = insertAuditRow({
      actorUserId,
      actorTokenId,
      semesterId,
      action,
      targetType,
      targetId,
      detail,
      ip,
      userAgent,
      at,
    }).catch((err: unknown) => {
      try {
        getLogger().warn({ err, action, targetType, targetId }, 'audit insert failed');
      } catch {
        // If logger is not available, silently ignore.
      }
    });

    // Test-only seam: let tests await the insert instead of using setTimeout.
    // In production onInsertComplete is undefined so this is a no-op.
    if (onInsertComplete !== undefined) {
      onInsertComplete(insertPromise as Promise<void>);
    }
  };
}

// ---------------------------------------------------------------------------
// insertAuditRow
// ---------------------------------------------------------------------------

interface AuditRowInput {
  actorUserId: string | null;
  actorTokenId: string | null;
  semesterId: string | null;
  action: string;
  targetType: string;
  targetId: string;
  detail: Record<string, unknown>;
  ip: string | null;
  userAgent: string | null;
  at: Date;
}

async function insertAuditRow(row: AuditRowInput): Promise<void> {
  const db = getDb();
  await db.insert(audit_log).values({
    actor_user_id: row.actorUserId ?? undefined,
    actor_token_id: row.actorTokenId ?? undefined,
    semester_id: row.semesterId ?? undefined,
    action: row.action,
    target_type: row.targetType,
    target_id: row.targetId,
    detail: row.detail,
    ip: row.ip ?? undefined,
    user_agent: row.userAgent ?? undefined,
    at: row.at,
  });
}
