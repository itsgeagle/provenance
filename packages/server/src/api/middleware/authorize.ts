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
 *   2. If `target === 'global'`, token scope checks run first, then superadmin check.
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
import { authorize, type Action, type Target, type AuthorizeResult } from '../../auth/authorize.js';
import { tokenScopesSchema } from '../../auth/tokens.js';
import { findMembership } from '../../auth/membership-cache.js';
import { getDb } from '../../db/client.js';
import { Errors } from '../v1/errors.js';
import type { ApiErrorCode } from '../v1/errors.js';
import type { Principal } from './auth-session.js';

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
// checkTokenScopes — steps 1–3 of the decision tree for global routes
// ---------------------------------------------------------------------------

/**
 * Checks token scope constraints for global routes (PRD §4.5 steps 1–3).
 *
 * Rules for target === 'global':
 *   - Null principal  → DENY AUTH_REQUIRED
 *   - Token with read_only=true AND action !== 'read' → DENY TOKEN_READ_ONLY
 *   - Token with semester_ids !== null → DENY TOKEN_SCOPE_OUT_OF_BAND
 *     Rationale: global resources are not tied to any semester. A token scoped
 *     to specific semesters should never be able to access global resources,
 *     even if the user is superadmin, because the token scope is more restrictive
 *     than the user's role. The only exception would be if semester_ids === null
 *     (an unrestricted token), which we allow through.
 *
 * Returns { ok: true } to proceed, or a deny result.
 */
function checkTokenScopes(principal: Principal, action: Action): AuthorizeResult {
  if (principal.principal_kind !== 'token') {
    // Session principals have no token scope restrictions.
    return { ok: true };
  }

  const raw = principal.token.scopes;
  const value = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
  const scopes = tokenScopesSchema.parse(value);

  // Step 2: read-only token attempting a non-read action
  if (scopes.read_only && action !== 'read') {
    return { ok: false, code: 'TOKEN_READ_ONLY' };
  }

  // Step 3 (global variant): token scoped to specific semesters cannot access
  // global resources — global resources are not in any semester scope.
  if (scopes.semester_ids !== null) {
    return { ok: false, code: 'TOKEN_SCOPE_OUT_OF_BAND' };
  }

  return { ok: true };
}

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
    // View-as guard (V45): a superadmin in view-as mode is strictly read-only.
    // Global and semester-scoped routes alike block non-read actions before
    // any other checks. Without this, a superadmin could still hit superadmin
    // bypasses below while supposedly impersonating a grader.
    // -----------------------------------------------------------------------
    const viewAs = principal.principal_kind === 'session' ? principal.viewAs : undefined;
    if (viewAs !== undefined && opts.action !== 'read') {
      return c.json(Errors.viewAsReadOnly().toBody(), 403);
    }

    // -----------------------------------------------------------------------
    // Step 2: global target — token scope checks FIRST, then superadmin check.
    //
    // PRD §4.5 specifies token scope checks precede the superadmin check.
    // A superadmin token with read_only=true must still be denied on a write
    // global route. A superadmin token scoped to specific semesters must still
    // be denied from global routes.
    //
    // View-as cannot reach global admin routes at all: global routes require
    // superadmin AND we forbid write under view-as above. A view-as 'read'
    // request to a global route is rare but allowed (superadmin is still
    // technically authorized for read-only structural inspection).
    // -----------------------------------------------------------------------
    if (opts.target === 'global') {
      const scopeResult = checkTokenScopes(principal, opts.action);
      if (!scopeResult.ok) {
        return denyGlobalResponse(c, scopeResult.code);
      }
      if (!principal.user.is_superadmin) {
        const err = Errors.insufficientRole('admin');
        return c.json(err.toBody(), 403);
      }
      c.set('target', null);
      await next();
      return;
    }

    // -----------------------------------------------------------------------
    // Step 3: semester-scoped target — resolve via factory
    // -----------------------------------------------------------------------
    let target: Target;
    try {
      target = opts.target(c);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json(Errors.validation([{ target_resolution_error: msg }]).toBody(), 400);
    }

    // -----------------------------------------------------------------------
    // Step 4: look up membership (request-scoped cache).
    //
    // View-as (V45): membership is looked up for the TARGET user, not the
    // superadmin. The superadmin's own memberships are irrelevant — the whole
    // point of view-as is to see exactly what the target would see.
    // -----------------------------------------------------------------------
    const cache = c.var.membershipCache;
    const db = getDb();
    const membershipUserId = viewAs !== undefined ? viewAs.userId : principal.user.id;
    const membership = await findMembership(cache, db, membershipUserId, target.semesterId);

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
      // Pass the action so the message is accurate if future actions require different roles.
      // Today both 'write' and 'admin' require 'admin' role, but this is forward-compatible.
      return c.json(Errors.insufficientRole('admin').toBody(), 403);
    case 'VIEW_AS_READ_ONLY':
      return c.json(Errors.viewAsReadOnly().toBody(), 403);
    default:
      return c.json(Errors.internal().toBody(), 500);
  }
}

/**
 * Deny response for global routes where there is no semester target.
 * Handles TOKEN_READ_ONLY and TOKEN_SCOPE_OUT_OF_BAND without a semesterId.
 */
function denyGlobalResponse(c: Context, code: ApiErrorCode): Response {
  switch (code) {
    case 'TOKEN_READ_ONLY':
      return c.json(Errors.tokenReadOnly().toBody(), 403);
    case 'TOKEN_SCOPE_OUT_OF_BAND':
      // No semesterId to include; the token has semester_ids !== null which
      // means it cannot access global (non-semester) resources.
      return c.json(Errors.tokenScopeOutOfBand('global').toBody(), 403);
    default:
      return c.json(Errors.internal().toBody(), 500);
  }
}
