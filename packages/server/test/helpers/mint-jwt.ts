/**
 * Test helper: mint a signed RS256 JWT using Node built-ins.
 *
 * No JWT library dependency. Used by jwks.test.ts, verify-id-token.test.ts,
 * and auth.test.ts to create valid / intentionally-invalid tokens.
 */

import * as crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Key generation
// ---------------------------------------------------------------------------

export interface TestKeyPair {
  privateKey: crypto.KeyObject;
  publicKey: crypto.KeyObject;
  jwk: object; // the public key as a JWK (no private fields)
  kid: string;
}

export function generateTestKeyPair(kid = 'test-kid-1'): TestKeyPair {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const jwk = publicKey.export({ format: 'jwk' });
  return { privateKey, publicKey, jwk, kid };
}

// ---------------------------------------------------------------------------
// JWT minting
// ---------------------------------------------------------------------------

function base64urlEncode(buf: Buffer): string {
  return buf.toString('base64url');
}

function jsonToBase64url(obj: object): string {
  return base64urlEncode(Buffer.from(JSON.stringify(obj), 'utf8'));
}

export interface JwtPayload {
  sub?: string;
  email?: string;
  email_verified?: boolean;
  iss?: string;
  aud?: string;
  exp?: number;
  iat?: number;
  hd?: string;
  name?: string;
  [key: string]: unknown;
}

export interface MintJwtOptions {
  /** Override the header `kid`. Defaults to `pair.kid`. */
  kid?: string;
  /** Override the header `alg`. Defaults to `'RS256'`. */
  alg?: string;
  /** Sign with a different private key than `pair.privateKey` (bad-key tests). */
  signWithKey?: crypto.KeyObject;
}

/**
 * Mints a signed JWT.
 *
 * @param pair    Key pair from `generateTestKeyPair`.
 * @param payload Claims to include in the JWT. Caller is responsible for
 *                setting exp/iat correctly (or deliberately wrong for tests).
 * @param opts    Optional overrides for header fields and signing key.
 * @returns       A raw JWT string (three base64url segments joined by '.').
 */
export function mintJwt(pair: TestKeyPair, payload: JwtPayload, opts: MintJwtOptions = {}): string {
  const alg = opts.alg ?? 'RS256';
  const kid = opts.kid ?? pair.kid;
  const signingKey = opts.signWithKey ?? pair.privateKey;

  const header = { alg, kid, typ: 'JWT' };
  const headerB64 = jsonToBase64url(header);
  const payloadB64 = jsonToBase64url(payload);

  const dataToSign = Buffer.from(`${headerB64}.${payloadB64}`, 'utf8');
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(dataToSign);
  const signatureB64 = sign.sign(signingKey).toString('base64url');

  return `${headerB64}.${payloadB64}.${signatureB64}`;
}

// ---------------------------------------------------------------------------
// Convenience: default valid payload for a given audience
// ---------------------------------------------------------------------------

export function validPayload(audience: string, overrides: Partial<JwtPayload> = {}): JwtPayload {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    iss: 'https://accounts.google.com',
    aud: audience,
    sub: 'google-sub-test-123',
    email: 'student@berkeley.edu',
    email_verified: true,
    hd: 'berkeley.edu',
    name: 'Test Student',
    iat: nowSec,
    exp: nowSec + 3600,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Build a minimal JWKs set from a TestKeyPair
// ---------------------------------------------------------------------------

export function jwksFromPair(pair: TestKeyPair): { keys: object[] } {
  return {
    keys: [{ ...pair.jwk, kty: 'RSA', kid: pair.kid, alg: 'RS256', use: 'sig' }],
  };
}
