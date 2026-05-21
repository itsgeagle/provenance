/**
 * requireAuth middleware factory (PRD §4.5).
 *
 * Usage:
 *   router.post('/semesters/:id/config',
 *     requireAuth({ action: 'write', target: (c) => ({ semesterId: c.req.param('id') }) }),
 *     audit('heuristic_config.commit', 'semester', (c) => c.req.param('id')),
 *     handler,
 *   );
 *
 * The factory:
 *   1. Reads `c.var.principal` (set by authSessionMiddleware upstream).
 *   2. If `target === 'global'`, only superadmins are allowed.
 *   3. Otherwise resolves target via the factory function.
 *   4. Looks up membership via `findMembership` (request-scoped cache).
 *   5. Calls `authorize(principal, action, target, membership)`.
 *   6. On ALLOW: sets `c.var.target` for audit middleware.
 *   7. On DENY: returns 401 or 403 with the appropriate error code.
 *
 * Prerequisite middlewares (must run upstream):
 *   - authSessionMiddleware (sets c.var.principal)
 *   - initMembershipCache (sets c.var.membershipCache)
 *
 * Context variables are declared in hono-context.d.ts.
 */

import type { Context, MiddlewareHandler } from 'hono';
import { authorize, type Action, type Target } from '../../auth/authorize.js';
import { findMembership } from '../../auth/membership-cache.js';
import { getDb } from '../../db/client.js';
import { Errors } from '../v1/errors.js';
import type { ApiErrorCode } from '../v1/errors.js';

// ---------------------------------------------------------------------------
// RequireAuthOptions
// ---------------------------------------------------------------------------

export type RequireAuthOptions = {
  /**
   * The action being performed.
   *   'read'  — visible to any member (admin or grader).
   *   'write' — requires admin role.
   *   'admin' — requires admin role (for structural operations).
   */
  action: Action;

  /**
   * How to resolve the authorization target.
   *   'global' — no semester target; only superadmins are allowed.
   *   function  — called with `c` to derive { semesterId } from path params or
   *               query params.
   */
  target: 'global' | ((c: Context) => Target);
};

// ---------------------------------------------------------------------------
// requireAuth
// ---------------------------------------------------------------------------

/**
 * Middleware factory that enforces authentication and authorization.
 *
 * Returns a Hono MiddlewareHandler. Call it inline when declaring a route:
 *   router.post('/path', requireAuth({ action: 'write', target: (c) => ... }), handler)
 *
 * On success: sets c.var.target and calls next().
 * On failure: returns 401 (AUTH_REQUIRED) or 403 (authorization code) with JSON body.
 */
export function requireAuth(opts: RequireAuthOptions): MiddlewareHandler {
  return async (c, next) => {
    const principal = c.var.principal ?? null;

    // -----------------------------------------------------------------------
    // Step 1: require authentication
    // -----------------------------------------------------------------------
    if (principal === null) {
      const returnTo = encodeURIComponent(c.req.path);
      const err = Errors.authRequired(`/api/v1/auth/google/start?return_to=${returnTo}`);
      return c.json(err.toBody(), 401);
    }

    // -----------------------------------------------------------------------
    // Step 2: global target — superadmin only
    // -----------------------------------------------------------------------
    if (opts.target === 'global') {
      if (!principal.user.is_superadmin) {
        const err = Errors.insufficientRole('admin');
        return c.json(err.toBody(), 403);
      }
      c.set('target', null);
      await next();
      return;
    }

    // -----------------------------------------------------------------------
    // Step 3: semester-scoped target
    // -----------------------------------------------------------------------
    const target = opts.target(c);

    // -----------------------------------------------------------------------
    // Step 4: look up membership (request-scoped cache)
    // -----------------------------------------------------------------------
    const cache = c.var.membershipCache;
    const db = getDb();
    const membership = await findMembership(cache, db, principal.user.id, target.semesterId);

    // -----------------------------------------------------------------------
    // Step 5: call authorize()
    // -----------------------------------------------------------------------
    const result = authorize(principal, opts.action, target, membership);

    // -----------------------------------------------------------------------
    // Step 6/7: allow or deny
    // -----------------------------------------------------------------------
    if (result.ok) {
      c.set('target', target);
      await next();
      return;
    }

    return denyResponse(c, result.code, target);
  };
}

// ---------------------------------------------------------------------------
// denyResponse — maps an authorization code to the right HTTP status + body
// ---------------------------------------------------------------------------

function denyResponse(c: Context, code: ApiErrorCode, target: Target): Response {
  switch (code) {
    case 'AUTH_REQUIRED': {
      const returnTo = encodeURIComponent(c.req.path);
      const err = Errors.authRequired(`/api/v1/auth/google/start?return_to=${returnTo}`);
      return c.json(err.toBody(), 401);
    }
    case 'TOKEN_READ_ONLY':
      return c.json(Errors.tokenReadOnly().toBody(), 403);
    case 'TOKEN_SCOPE_OUT_OF_BAND':
      return c.json(Errors.tokenScopeOutOfBand(target.semesterId).toBody(), 403);
    case 'NOT_A_MEMBER':
      return c.json(Errors.notAMember().toBody(), 403);
    case 'INSUFFICIENT_ROLE':
      return c.json(Errors.insufficientRole('admin').toBody(), 403);
    default:
      return c.json(Errors.internal().toBody(), 500);
  }
}
