/**
 * Bearer token authentication middleware.
 *
 * Reads the `Authorization: Bearer <token>` header, resolves and verifies the token,
 * and binds the resolved principal to `c.var.principal`.
 *
 * Context variable contract:
 *   c.var.principal — null | Principal (set by this middleware or auth-session)
 *
 * Precedence: auth-resolve.ts handles precedence. This middleware is called
 * only when auth-resolve decides to use bearer auth.
 *
 * Token verification:
 * 1. Parse the Authorization header to extract the token secret
 * 2. Extract the prefix from the token
 * 3. Look up the token by prefix in the database
 * 4. Verify the hash + revocation + expiry
 * 5. Update last_used_at
 * 6. Attach principal with kind='token' to c.var
 */

import type { Context } from 'hono';
import { getDb } from '../../db/client.js';
import { users } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import {
  extractPrefix,
  findTokenByPrefix,
  verifyToken,
  updateTokenLastUsed,
} from '../../auth/tokens.js';
import type { Principal } from './auth-session.js';
import { getLogger } from '../../logging.js';

// ---------------------------------------------------------------------------
// Bearer token parsing
// ---------------------------------------------------------------------------

/**
 * Parses the Authorization header to extract the Bearer token.
 * Returns the token string or null if the header is missing or malformed.
 */
export function parseBearerHeader(authHeader: string | undefined | null): string | null {
  if (authHeader === undefined || authHeader === null) return null;
  // Exactly one space between "Bearer" and the token; the token must start with
  // a non-space character. This rejects "Bearer  prov_xxx" (two spaces), which
  // with \s+ would silently extract " prov_xxx" (leading space) and then fail
  // downstream as a silent "no token found" rather than an explicit invalid_bearer.
  // RFC 6750 form: Authorization: Bearer <token> (single space, no leading space in token).
  const match = authHeader.match(/^Bearer ([^ ].*)$/i);
  return match?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Token resolution
// ---------------------------------------------------------------------------

/**
 * Resolves a bearer token to a principal.
 *
 * Returns a principal { principal_kind: 'token', user, token } on success,
 * or null if the token is invalid/revoked/expired.
 *
 * On successful verification, updates the token's last_used_at timestamp.
 */
export async function resolveBearerToken(secret: string): Promise<Principal | null> {
  const prefix = extractPrefix(secret);
  if (prefix === null) return null;

  const db = getDb();

  // Look up the token by prefix
  const token = await findTokenByPrefix(db, prefix);
  if (token === null) return null;

  // Verify: hash + revocation + expiry
  const isValid = await verifyToken(token, secret);
  if (!isValid) return null;

  // Fetch the user
  const userRows = await db.select().from(users).where(eq(users.id, token.user_id)).limit(1);
  const user = userRows[0];
  if (user === undefined) return null;

  // Update last_used_at (fire-and-forget to avoid blocking the request).
  // Errors are logged as warnings; a failure here is observable but not fatal.
  updateTokenLastUsed(db, token.id).catch((err: unknown) => {
    getLogger().warn({ err, tokenId: token.id }, 'updateTokenLastUsed failed');
  });

  return { principal_kind: 'token', user, token };
}

// ---------------------------------------------------------------------------
// Middleware (exported for use in auth-resolve.ts)
// ---------------------------------------------------------------------------

/**
 * Bearer token middleware — resolves the Authorization: Bearer header.
 * This middleware is called by auth-resolve.ts, not directly.
 *
 * Does NOT set c.var.principal — that's auth-resolve's job.
 * Instead, returns the resolved principal for auth-resolve to use.
 *
 * (In a real middleware, this would be called directly and would set c.var;
 *  but auth-resolve needs to handle both session + token, so it calls the
 *  resolve function directly.)
 */
export async function resolveBearerTokenPrincipal(c: Context): Promise<Principal | null> {
  const authHeader = c.req.header('authorization');
  const token = parseBearerHeader(authHeader);
  if (token === null) return null;

  return resolveBearerToken(token);
}
