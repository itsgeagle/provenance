/**
 * Cookie helpers for Provenance session and OAuth state cookies.
 *
 * Cookie attributes (PRD §4.2):
 *   HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=<SESSION_TTL_SECONDS>
 *
 * `__Host-` prefix enforcement:
 *   In production, the SESSION_COOKIE_NAME must start with `__Host-`
 *   (validated by the env schema at boot, env.ts cross-field check).
 *   The `__Host-` prefix requires `Secure`, `Path=/`, and no `Domain`.
 *   Hono's `setCookie` enforces this via `CookieConstraint<Name>` when
 *   we pass `prefix: 'host'` — it adds `Secure` and `Path=/` automatically.
 *   We always pass all attributes explicitly for clarity.
 *
 * OAuth state cookie (`__Host-prov_oauth`):
 *   Short-lived (10 min), stores signed JSON payload for CSRF + PKCE.
 *   Signed with HMAC-SHA256 using AUTH_COOKIE_SIGNING_SECRET.
 *
 * Design decision: the OAuth state is stored client-side in a signed cookie
 * rather than server-side in a DB table. This avoids a DB write on every
 * login initiation. The cookie is HMAC-signed, so a malicious client cannot
 * forge state. See .notes/v3-progress.md §V14 for the full decision record.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { getConfig } from '../config/index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const OAUTH_COOKIE_NAME = '__Host-prov_oauth';
export const OAUTH_COOKIE_MAX_AGE = 10 * 60; // 10 minutes

// ---------------------------------------------------------------------------
// Signing key
// ---------------------------------------------------------------------------

/**
 * Returns the HMAC signing key for the OAuth state cookie.
 *
 * Uses AUTH_COOKIE_SIGNING_SECRET from env if set; falls back to a fixed
 * dev-only value when NODE_ENV !== 'production'. The env schema does NOT
 * require this var in non-production environments; see .notes/v3-progress.md
 * §V14 for the full rationale.
 *
 * New env var added in Phase 2: AUTH_COOKIE_SIGNING_SECRET
 * (32+ bytes base64, required in production via env validation added in
 * this phase — see env.ts).
 */
function getSigningSecret(): string {
  const cfg = getConfig();
  // We read the raw env var directly because we added it as an optional field
  // and getConfig() already validated it.
  return cfg.AUTH_COOKIE_SIGNING_SECRET;
}

// ---------------------------------------------------------------------------
// HMAC signing / verification
// ---------------------------------------------------------------------------

function sign(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function signedValue(secret: string, payload: string): string {
  return `${payload}.${sign(secret, payload)}`;
}

function verifyAndExtract(secret: string, signedStr: string): string | null {
  const dotIdx = signedStr.lastIndexOf('.');
  if (dotIdx === -1) return null;
  const payload = signedStr.slice(0, dotIdx);
  const mac = signedStr.slice(dotIdx + 1);
  const expected = sign(secret, payload);
  // Constant-time comparison
  try {
    const expectedBuf = Buffer.from(expected, 'base64url');
    const actualBuf = Buffer.from(mac, 'base64url');
    if (expectedBuf.length !== actualBuf.length) return null;
    if (!timingSafeEqual(expectedBuf, actualBuf)) return null;
  } catch {
    return null;
  }
  return payload;
}

// ---------------------------------------------------------------------------
// OAuth state payload
// ---------------------------------------------------------------------------

export interface OAuthStateCookiePayload {
  state: string;
  codeVerifier: string;
  returnTo: string;
}

/**
 * Sets the `__Host-prov_oauth` cookie with a signed JSON payload.
 */
export function setOAuthStateCookie(c: Context, payload: OAuthStateCookiePayload): void {
  const secret = getSigningSecret();
  const json = JSON.stringify(payload);
  const encoded = Buffer.from(json).toString('base64url');
  const signed = signedValue(secret, encoded);

  setCookie(c, OAUTH_COOKIE_NAME, signed, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: OAUTH_COOKIE_MAX_AGE,
  });
}

/**
 * Reads and verifies the `__Host-prov_oauth` cookie.
 * Returns the payload or `null` if missing, tampered, or malformed.
 */
export function getOAuthStateCookie(c: Context): OAuthStateCookiePayload | null {
  const secret = getSigningSecret();
  const raw = getCookie(c, OAUTH_COOKIE_NAME);
  if (raw === undefined) return null;

  const payload = verifyAndExtract(secret, raw);
  if (payload === null) return null;

  try {
    const json = Buffer.from(payload, 'base64url').toString('utf-8');
    const parsed: unknown = JSON.parse(json);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>)['state'] !== 'string' ||
      typeof (parsed as Record<string, unknown>)['codeVerifier'] !== 'string' ||
      typeof (parsed as Record<string, unknown>)['returnTo'] !== 'string'
    ) {
      return null;
    }
    return parsed as OAuthStateCookiePayload;
  } catch {
    return null;
  }
}

/**
 * Clears the `__Host-prov_oauth` cookie (set Max-Age=0).
 */
export function clearOAuthStateCookie(c: Context): void {
  deleteCookie(c, OAUTH_COOKIE_NAME, {
    secure: true,
    path: '/',
  });
}

// ---------------------------------------------------------------------------
// Session cookie
// ---------------------------------------------------------------------------

/**
 * Sets the session cookie using the SESSION_COOKIE_NAME from env.
 */
export function setSessionCookie(c: Context, sessionId: string, maxAgeSec: number): void {
  const cfg = getConfig();
  setCookie(c, cfg.SESSION_COOKIE_NAME, sessionId, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: maxAgeSec,
  });
}

/**
 * Reads the session id from the session cookie.
 * Returns `undefined` if absent.
 */
export function getSessionCookie(c: Context): string | undefined {
  const cfg = getConfig();
  return getCookie(c, cfg.SESSION_COOKIE_NAME);
}

/**
 * Clears the session cookie (set Max-Age=0).
 */
export function clearSessionCookie(c: Context): void {
  const cfg = getConfig();
  deleteCookie(c, cfg.SESSION_COOKIE_NAME, {
    secure: true,
    path: '/',
  });
}
