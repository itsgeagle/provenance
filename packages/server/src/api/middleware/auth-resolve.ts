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

// ---------------------------------------------------------------------------
// ResolveResult sum type
// ---------------------------------------------------------------------------

/**
 * Three-way result from resolvePrincipal:
 *   - 'ok'             — credentials were offered and verified; principal is set.
 *   - 'none'           — no credentials offered; downstream decides 401 vs 200.
 *   - 'invalid_bearer' — a Bearer header was offered but is malformed or invalid;
 *                        callers MUST return 401 immediately (no session fallback).
 */
export type ResolveResult =
  | { kind: 'ok'; principal: Principal }
  | { kind: 'none' }
  | { kind: 'invalid_bearer' };

// ---------------------------------------------------------------------------
// resolvePrincipal
// ---------------------------------------------------------------------------

/**
 * Resolves the principal from the request, trying bearer token first,
 * then session cookie, with proper precedence handling.
 *
 * Returns a ResolveResult discriminated union:
 *   - { kind: 'ok', principal }   — authenticated; use principal.
 *   - { kind: 'none' }            — no credentials; routes decide.
 *   - { kind: 'invalid_bearer' }  — Bearer was offered but invalid; caller MUST 401.
 *
 * Callers must check `kind === 'invalid_bearer'` and return 401 immediately.
 * They must NOT fall back to session auth when Bearer is present but invalid.
 */
export async function resolvePrincipal(c: Context): Promise<ResolveResult> {
  const authHeader = c.req.header('authorization');

  // Precedence rule: if Authorization header is present, use bearer auth exclusively.
  if (authHeader !== undefined) {
    const bearerToken = parseBearerHeader(authHeader);

    if (bearerToken === null) {
      // Authorization header was offered but is malformed (e.g. "Basic ...",
      // "Bearer" with no token, no space before token).
      return { kind: 'invalid_bearer' };
    }

    const principal = await resolveBearerToken(bearerToken);
    if (principal === null) {
      // Header was well-formed but token is revoked, expired, or not found.
      return { kind: 'invalid_bearer' };
    }

    return { kind: 'ok', principal };
  }

  // No Authorization header — try session cookie.
  const principal = await resolveSessionPrincipal(c);
  if (principal === null) return { kind: 'none' };
  return { kind: 'ok', principal };
}

// ---------------------------------------------------------------------------
// resolveSessionPrincipal
// ---------------------------------------------------------------------------

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
