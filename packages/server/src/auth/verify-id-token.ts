/**
 * Google ID token verification (RS256, JWK-backed).
 *
 * `verifyIdToken` is the single function that combines:
 * 1. JWT parsing (header + payload + signature)
 * 2. RS256 signature verification via Node's built-in `node:crypto`
 * 3. Standard claims validation (iss, aud, exp, iat)
 *
 * The JWKs fetcher is injected as an optional dependency so tests can supply
 * a synthetic key set without network access.
 */

import * as crypto from 'node:crypto';
import { type JwkSet, type Jwk, getGoogleJwks, findKeyByKid } from './jwks.js';

// ---------------------------------------------------------------------------
// Verified claims shape
// ---------------------------------------------------------------------------

/**
 * The narrowed, verified claims returned after successful verification.
 * Only contains fields downstream code actually uses.
 */
export interface VerifiedClaims {
  sub: string;
  email: string;
  email_verified: boolean;
  iss: string;
  aud: string;
  exp: number;
  iat: number;
  hd?: string | undefined;
  name?: string | undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function base64urlDecode(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

function parseBase64urlJson(s: string): unknown {
  try {
    return JSON.parse(base64urlDecode(s).toString('utf8'));
  } catch {
    throw new Error('Invalid base64url JSON segment');
  }
}

// ---------------------------------------------------------------------------
// JWT header guard
// ---------------------------------------------------------------------------

interface JwtHeader {
  alg: string;
  kid: string;
}

function parseHeader(raw: unknown): JwtHeader {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('JWT header is not an object');
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj['alg'] !== 'string') throw new Error('JWT header missing alg');
  if (typeof obj['kid'] !== 'string') throw new Error('JWT header missing kid');
  return { alg: obj['alg'], kid: obj['kid'] };
}

// ---------------------------------------------------------------------------
// Payload guard (raw — before we assert business claims)
// ---------------------------------------------------------------------------

interface RawPayload {
  iss: unknown;
  aud: unknown;
  exp: unknown;
  iat: unknown;
  sub: unknown;
  email: unknown;
  email_verified: unknown;
  hd: unknown;
  name: unknown;
}

function parsePayload(raw: unknown): RawPayload {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('JWT payload is not an object');
  }
  const obj = raw as Record<string, unknown>;
  return {
    iss: obj['iss'],
    aud: obj['aud'],
    exp: obj['exp'],
    iat: obj['iat'],
    sub: obj['sub'],
    email: obj['email'],
    email_verified: obj['email_verified'],
    hd: obj['hd'],
    name: obj['name'],
  };
}

// ---------------------------------------------------------------------------
// Key selection with single retry on kid miss
// ---------------------------------------------------------------------------

async function selectKey(
  kid: string,
  fetchJwks: (opts?: { force?: boolean }) => Promise<JwkSet>,
): Promise<Jwk> {
  // First attempt using (potentially cached) JWKs.
  const firstSet = await fetchJwks();
  const found = findKeyByKid(firstSet, kid);
  if (found !== undefined) return found;

  // kid not found — Google may have rotated keys since the last cache fill.
  // Force a fresh HTTP fetch (bypassing the in-memory cache) and retry once.
  // `force: true` is what distinguishes this from the first call — without it
  // getGoogleJwks would return the same cached set again and the retry would
  // be a no-op.
  const secondSet = await fetchJwks({ force: true });
  const retry = findKeyByKid(secondSet, kid);
  if (retry !== undefined) return retry;

  throw new Error(`No JWK found for kid="${kid}"`);
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export interface VerifyIdTokenOptions {
  /** Override the JWKs fetcher for testing. Defaults to `getGoogleJwks`. */
  fetchJwks?: (opts?: { force?: boolean }) => Promise<JwkSet>;
}

const VALID_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const MAX_IAT_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Verifies a Google ID token (RS256) against Google's JWKs and validates
 * standard OIDC claims. Returns the narrowed, verified payload.
 *
 * Throws a plain `Error` on any verification failure. The route handler maps
 * these to `AUTH_OAUTH_CODE_EXCHANGE_FAILED` (502).
 *
 * @param jwt      The raw JWT string (three base64url-encoded segments).
 * @param audience The expected `aud` claim (your Google OAuth client ID).
 * @param opts     Optional overrides (primarily for testing).
 */
export async function verifyIdToken(
  jwt: string,
  audience: string,
  opts: VerifyIdTokenOptions = {},
): Promise<VerifiedClaims> {
  const fetchJwks = opts.fetchJwks ?? getGoogleJwks;

  // 1. Parse JWT structure.
  const parts = jwt.split('.');
  if (parts.length !== 3) {
    throw new Error('Malformed JWT: expected 3 segments');
  }
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

  // 2. Decode header; enforce RS256.
  const header = parseHeader(parseBase64urlJson(headerB64));
  if (header.alg !== 'RS256') {
    throw new Error(`Unsupported JWT algorithm: ${header.alg} (expected RS256)`);
  }

  // 3. Fetch public key matching kid.
  const jwk = await selectKey(header.kid, fetchJwks);

  // 4. Build KeyObject from JWK.
  // crypto.createPublicKey({ format: 'jwk', key: <JsonWebKey> }) is the
  // canonical Node ≥22 form. The `Jwk` type we export satisfies JsonWebKey.
  let keyObject: crypto.KeyObject;
  try {
    keyObject = crypto.createPublicKey({ format: 'jwk', key: jwk as crypto.JsonWebKey });
  } catch (err) {
    throw new Error(
      `Failed to create public key from JWK: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 5. Verify signature.
  const dataToSign = Buffer.from(`${headerB64}.${payloadB64}`, 'utf8');
  const signatureBytes = base64urlDecode(sigB64);

  const valid = crypto.verify('RSA-SHA256', dataToSign, keyObject, signatureBytes);
  if (!valid) {
    throw new Error('JWT signature verification failed');
  }

  // 6. Decode and validate claims.
  const rawPayload = parsePayload(parseBase64urlJson(payloadB64));

  // iss
  if (typeof rawPayload.iss !== 'string' || !VALID_ISSUERS.has(rawPayload.iss)) {
    throw new Error(`Invalid JWT iss: ${String(rawPayload.iss)}`);
  }

  // aud — RFC 7519 §4.1.3 allows a single string OR an array of strings.
  // Google emits arrays in some contexts (e.g. when azp is present).
  const aud = rawPayload.aud;
  if (typeof aud === 'string') {
    if (aud !== audience) {
      throw new Error(`Invalid JWT aud: expected "${audience}", got "${aud}"`);
    }
  } else if (Array.isArray(aud) && aud.every((v) => typeof v === 'string')) {
    if (!(aud as string[]).includes(audience)) {
      throw new Error(`Invalid JWT aud: "${audience}" not found in [${(aud as string[]).join(', ')}]`);
    }
  } else {
    throw new Error('Invalid JWT aud: must be string or string[]');
  }

  // exp
  if (typeof rawPayload.exp !== 'number') {
    throw new Error('JWT missing exp claim');
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (rawPayload.exp <= nowSec) {
    throw new Error('JWT has expired');
  }

  // iat
  if (typeof rawPayload.iat !== 'number') {
    throw new Error('JWT missing iat claim');
  }
  const iatMs = rawPayload.iat * 1000;
  const ageMs = Date.now() - iatMs;
  if (ageMs > MAX_IAT_AGE_MS) {
    throw new Error('JWT iat is too old (> 24 hours)');
  }
  if (iatMs > Date.now() + 5 * 60 * 1000) {
    // Allow 5-minute future skew for clock drift; reject beyond that.
    throw new Error('JWT iat is in the future');
  }

  // Required claims.
  if (typeof rawPayload.sub !== 'string') throw new Error('JWT missing sub claim');
  if (typeof rawPayload.email !== 'string') throw new Error('JWT missing email claim');
  if (typeof rawPayload.email_verified !== 'boolean')
    throw new Error('JWT missing email_verified claim');

  return {
    sub: rawPayload.sub,
    email: rawPayload.email,
    email_verified: rawPayload.email_verified,
    iss: rawPayload.iss,
    aud: audience,
    exp: rawPayload.exp,
    iat: rawPayload.iat,
    hd: typeof rawPayload.hd === 'string' ? rawPayload.hd : undefined,
    name: typeof rawPayload.name === 'string' ? rawPayload.name : undefined,
  };
}
