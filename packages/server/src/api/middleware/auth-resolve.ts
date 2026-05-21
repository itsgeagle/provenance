/**
 * Auth resolution middleware with precedence handling.
 *
 * Combines session-cookie and bearer-token authentication with a strict
 * precedence rule: **bearer token beats session cookie**.
 *
 * If an Authorization: Bearer header is present (and valid), use that principal.
 * If the header is present but invalid, return 401 immediately (no fallback to session).
 * If the header is absent, try the session cookie.
 * If both are absent, the principal is null (routes decide 401 vs 200).
 *
 * This is the structural seam that routes use instead of calling session/token
 * middleware directly. Phase 3 replaces `resolvePrincipal` in auth-session.ts
 * with a call to this middleware.
 *
 * Context variable contract:
 *   c.var.principal — null | Principal (set by this middleware)
 */

import type { Context } from 'hono';
import { parseBearerHeader, resolveBearerToken } from './auth-token.js';
import { getDb } from '../../db/client.js';
import { users } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { findSession } from '../../auth/sessions.js';
import { getSessionCookie } from '../../auth/cookies.js';
import type { Principal } from './auth-session.js';

/**
 * Resolves the principal from the request, trying bearer token first,
 * then session cookie, with proper precedence handling.
 *
 * Returns:
 *   - A principal if either bearer or session auth succeeds
 *   - null if neither is present (does not throw; routes decide auth requirement)
 *   - Throws 401 if bearer header is present but invalid (no fallback)
 *
 * (Throws is a bit of a misnomer here for the error response;
 *  in real usage, auth-session.ts will call buildAuthRequiredResponse.)
 */
export async function resolvePrincipal(c: Context): Promise<Principal | null> {
  const authHeader = c.req.header('authorization');
  const bearerToken = parseBearerHeader(authHeader);

  // Precedence rule: if Authorization header is present, use bearer auth exclusively.
  if (authHeader !== undefined) {
    // Header is present, so we commit to bearer auth.
    // This means if the token is invalid, we return null (not 401 here;
    // the middleware/route will handle 401).
    if (bearerToken === null) {
      // Malformed Authorization header
      return null;
    }

    const principal = await resolveBearerToken(bearerToken);
    return principal; // null if invalid, principal if valid
  }

  // No Authorization header — try session cookie
  return resolveSessionPrincipal(c);
}

/**
 * Resolves the principal from the session cookie.
 * Used by resolvePrincipal when no bearer token is provided.
 */
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
