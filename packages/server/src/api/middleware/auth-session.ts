/**
 * Auth session middleware and principal types.
 *
 * Reads either a bearer token (Authorization: Bearer) or session cookie,
 * validates it in the DB, and binds the resolved principal to `c.var.principal`.
 *
 * Context variable contract:
 *   c.var.principal — null | Principal
 *
 * The middleware ALWAYS runs and sets `c.var.principal`. Individual route
 * handlers decide whether to require authentication by calling
 * `requirePrincipal(c)` (which throws 401 if null) or reading
 * `c.var.principal` directly for optional auth.
 *
 * Why `c.var` (Hono context variables) vs middleware injection:
 * - `c.var` is Hono's idiomatic pattern for request-scoped state.
 * - Type-safety is achieved by augmenting the `ContextVariableMap` interface (see ../hono-context.d.ts).
 *
 * Phase 3 change: resolvePrincipal now reads bearer token (with precedence)
 * or session cookie, via auth-resolve.ts. Routes remain unchanged.
 */

import type { Context, MiddlewareHandler } from 'hono';
import type { Session, User, ApiToken } from '../../db/schema.js';
import { resolvePrincipal, type ResolveResult } from './auth-resolve.js';

// ---------------------------------------------------------------------------
// Principal type
// ---------------------------------------------------------------------------

/**
 * A resolved, authenticated principal for a request.
 *
 * Discriminated union on `principal_kind`:
 *  - `'session'` — authenticated via session cookie (Phase 2).
 *  - `'token'`   — authenticated via API bearer token (Phase 3).
 *
 * Callers that need `session` must narrow on `principal_kind === 'session'`.
 * Callers that need `token` must narrow on `principal_kind === 'token'`.
 * The union is fully additive: Phase 3 appends the token branch without
 * modifying existing session-principal consumers.
 */
export type Principal =
  | { principal_kind: 'session'; session: Session; user: User }
  | { principal_kind: 'token'; user: User; token: ApiToken };

// ---------------------------------------------------------------------------
// Principal resolution (Phase 3: bearer + session with precedence)
// ---------------------------------------------------------------------------

/**
 * Resolves the principal from the request context.
 * Phase 3: reads bearer token (with precedence) or session cookie.
 *
 * resolvePrincipal is imported from auth-resolve.ts (above), which handles
 * the precedence rule: if Authorization: Bearer is present, use it exclusively;
 * otherwise use session.
 *
 * Returns a ResolveResult discriminated union. Re-exported here so routes that
 * import from auth-session.ts do not need to reach into auth-resolve.ts directly.
 */
export { resolvePrincipal };
export type { ResolveResult };

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * Middleware that resolves the principal and sets `c.var.principal`.
 * Must be mounted before any route that reads `c.var.principal`.
 *
 * - 'ok'             → sets c.var.principal and calls next().
 * - 'none'           → sets c.var.principal to null and calls next();
 *                      protected routes enforce auth via requirePrincipal().
 * - 'invalid_bearer' → returns 401 immediately with WWW-Authenticate: Bearer.
 */
export const authSessionMiddleware: MiddlewareHandler = async (c, next) => {
  const result = await resolvePrincipal(c);

  if (result.kind === 'invalid_bearer') {
    const returnTo = encodeURIComponent(c.req.path);
    return c.json(
      {
        error: {
          code: 'AUTH_REQUIRED',
          message: 'Authentication required',
          details: { login_url: `/api/v1/auth/google/start?return_to=${returnTo}` },
        },
      },
      401,
      { 'WWW-Authenticate': 'Bearer' },
    );
  }

  c.set('principal', result.kind === 'ok' ? result.principal : null);
  await next();
};

// ---------------------------------------------------------------------------
// Route-level guard
// ---------------------------------------------------------------------------

/**
 * Returns the principal or throws a 401 JSON response.
 *
 * Usage in route handlers:
 *   const principal = requirePrincipal(c);
 *
 * The 401 response follows PRD §4.1 + §7.3:
 *   WWW-Authenticate: Cookie
 *   { "error": { "code": "AUTH_REQUIRED", "details": { "login_url": "..." } } }
 */
export function requirePrincipal(c: Context): Principal {
  const principal = c.var.principal;
  if (principal === null || principal === undefined) {
    const returnTo = encodeURIComponent(c.req.path);
    throw buildAuthRequiredResponse(c, returnTo);
  }
  return principal;
}

/**
 * Builds the 401 Response object for unauthenticated requests.
 * Exported so middleware can produce it without going through requirePrincipal.
 */
export function buildAuthRequiredResponse(c: Context, returnTo: string): Response {
  const loginUrl = `/api/v1/auth/google/start?return_to=${returnTo}`;
  return c.json(
    {
      error: {
        code: 'AUTH_REQUIRED',
        message: 'Authentication required',
        details: { login_url: loginUrl },
      },
    },
    401,
    { 'WWW-Authenticate': 'Cookie' },
  );
}
