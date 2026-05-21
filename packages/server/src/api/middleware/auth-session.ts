/**
 * Auth session middleware.
 *
 * Reads the session cookie, validates the session in the DB, and binds the
 * resolved principal to `c.var.principal`.
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
 * - Type-safety is achieved by augmenting the `ContextVariableMap` interface.
 * - The seam for Phase 3 (bearer tokens): `resolvePrincipal(c)` reads
 *   session OR token; only session is implemented here. Phase 3 will extend
 *   `resolvePrincipal` without modifying routes.
 */

import type { Context, MiddlewareHandler } from 'hono';
import { getSessionCookie } from '../../auth/cookies.js';
import { findSession } from '../../auth/sessions.js';
import { getDb } from '../../db/client.js';
import type { Session, User } from '../../db/schema.js';
import { users } from '../../db/schema.js';
import { eq } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Principal type
// ---------------------------------------------------------------------------

/**
 * A resolved, authenticated principal for a request.
 *
 * `principal_kind: 'session'` is the only kind in Phase 2.
 * Phase 3 adds `'token'`.
 */
export interface Principal {
  principal_kind: 'session' | 'token';
  session: Session;
  user: User;
}

// ---------------------------------------------------------------------------
// Hono context variable augmentation
// ---------------------------------------------------------------------------

// Augment Hono's ContextVariableMap so TypeScript knows about `principal`.
declare module 'hono' {
  interface ContextVariableMap {
    principal: Principal | null;
    // Phase 3 seam: googleOAuthClient can be injected per-request in tests.
    // In production routes, the module-level singleton is used instead.
  }
}

// ---------------------------------------------------------------------------
// Principal resolution (Phase 2: session only)
// ---------------------------------------------------------------------------

/**
 * Resolves the principal from the request context.
 * Phase 2: reads session cookie only.
 * Phase 3: extend this to also try bearer token before returning null.
 *
 * This is the structural seam that Phase 3 extends without modifying routes.
 */
export async function resolvePrincipal(c: Context): Promise<Principal | null> {
  return resolveSessionPrincipal(c);
}

async function resolveSessionPrincipal(c: Context): Promise<Principal | null> {
  const sessionId = getSessionCookie(c);
  if (sessionId === undefined) return null;

  const db = getDb();
  const session = await findSession(db, sessionId);
  if (session === null) return null;

  // Fetch the user row
  const userRows = await db.select().from(users).where(eq(users.id, session.user_id)).limit(1);
  const user = userRows[0];
  if (user === undefined) return null;

  return { principal_kind: 'session', session, user };
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * Middleware that resolves the principal and sets `c.var.principal`.
 * Must be mounted before any route that reads `c.var.principal`.
 *
 * Does NOT enforce authentication — routes do that by calling
 * `requirePrincipal(c)` or checking `c.var.principal` directly.
 */
export const authSessionMiddleware: MiddlewareHandler = async (c, next) => {
  const principal = await resolvePrincipal(c);
  c.set('principal', principal);
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
