/**
 * Unit tests for verifyIdToken.
 *
 * Uses a synthetically generated RSA keypair so no network access is needed.
 * The JWKs fetcher is injected via the options argument.
 */

import { describe, it, expect } from 'vitest';
import { verifyIdToken } from './verify-id-token.js';
import {
  generateTestKeyPair,
  mintJwt,
  validPayload,
  jwksFromPair,
} from '../../test/helpers/mint-jwt.js';
import type { JwkSet } from './jwks.js';
import * as crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const AUDIENCE = 'test-client-id';
const pair = generateTestKeyPair('test-kid');
const fakeJwks = jwksFromPair(pair) as JwkSet;
const fetchJwks = async (): Promise<JwkSet> => fakeJwks;

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('verifyIdToken — happy path', () => {
  it('returns verified claims for a valid RS256 JWT', async () => {
    const payload = validPayload(AUDIENCE, {
      sub: 'google-sub-123',
      email: 'student@berkeley.edu',
      email_verified: true,
      hd: 'berkeley.edu',
      name: 'Test Student',
    });
    const jwt = mintJwt(pair, payload);
    const claims = await verifyIdToken(jwt, AUDIENCE, { fetchJwks });

    expect(claims.sub).toBe('google-sub-123');
    expect(claims.email).toBe('student@berkeley.edu');
    expect(claims.email_verified).toBe(true);
    expect(claims.hd).toBe('berkeley.edu');
    expect(claims.name).toBe('Test Student');
    expect(claims.iss).toBe('https://accounts.google.com');
  });

  it('accepts the alternative issuer "accounts.google.com"', async () => {
    const payload = validPayload(AUDIENCE, { iss: 'accounts.google.com' });
    const jwt = mintJwt(pair, payload);
    await expect(verifyIdToken(jwt, AUDIENCE, { fetchJwks })).resolves.toBeDefined();
  });

  it('optional hd and name are undefined when absent from payload', async () => {
    const payload = validPayload(AUDIENCE);
    // Remove optional fields.
    const { hd: _hd, name: _name, ...rest } = payload; // eslint-disable-line @typescript-eslint/no-unused-vars
    const jwt = mintJwt(pair, rest);
    const claims = await verifyIdToken(jwt, AUDIENCE, { fetchJwks });
    expect(claims.hd).toBeUndefined();
    expect(claims.name).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Signature / key failures
// ---------------------------------------------------------------------------

describe('verifyIdToken — signature failures', () => {
  it('throws when signed with a different private key', async () => {
    const { privateKey: otherKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const payload = validPayload(AUDIENCE);
    const jwt = mintJwt(pair, payload, { signWithKey: otherKey });
    await expect(verifyIdToken(jwt, AUDIENCE, { fetchJwks })).rejects.toThrow(
      /signature verification failed/i,
    );
  });

  it('throws when JWT has wrong alg (HS256)', async () => {
    const payload = validPayload(AUDIENCE);
    const jwt = mintJwt(pair, payload, { alg: 'HS256' });
    await expect(verifyIdToken(jwt, AUDIENCE, { fetchJwks })).rejects.toThrow(
      /RS256/i,
    );
  });

  it('throws when JWT has missing kid in header', async () => {
    // Mint a JWT manually without the kid field.
    function base64urlEncode(s: string): string {
      return Buffer.from(s, 'utf8').toString('base64url');
    }
    const header = base64urlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payloadB64 = base64urlEncode(JSON.stringify(validPayload(AUDIENCE)));
    const dataToSign = Buffer.from(`${header}.${payloadB64}`, 'utf8');
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(dataToSign);
    const sig = sign.sign(pair.privateKey).toString('base64url');
    const jwt = `${header}.${payloadB64}.${sig}`;

    await expect(verifyIdToken(jwt, AUDIENCE, { fetchJwks })).rejects.toThrow(
      /kid/i,
    );
  });

  it('throws when kid is not found in JWKs', async () => {
    const payload = validPayload(AUDIENCE);
    const jwt = mintJwt(pair, payload, { kid: 'unknown-kid' });
    await expect(verifyIdToken(jwt, AUDIENCE, { fetchJwks })).rejects.toThrow(
      /No JWK found for kid/i,
    );
  });

  it('throws when JWT is malformed (not 3 segments)', async () => {
    await expect(verifyIdToken('a.b', AUDIENCE, { fetchJwks })).rejects.toThrow(
      /Malformed JWT/i,
    );
  });
});

// ---------------------------------------------------------------------------
// Claims failures
// ---------------------------------------------------------------------------

describe('verifyIdToken — claims failures', () => {
  it('throws when iss is wrong', async () => {
    const payload = validPayload(AUDIENCE, { iss: 'https://evil.com' });
    const jwt = mintJwt(pair, payload);
    await expect(verifyIdToken(jwt, AUDIENCE, { fetchJwks })).rejects.toThrow(
      /Invalid JWT iss/i,
    );
  });

  it('throws when aud does not match', async () => {
    const payload = validPayload(AUDIENCE, { aud: 'wrong-client-id' });
    const jwt = mintJwt(pair, payload);
    await expect(verifyIdToken(jwt, AUDIENCE, { fetchJwks })).rejects.toThrow(
      /Invalid JWT aud/i,
    );
  });

  it('throws when token is expired', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const payload = validPayload(AUDIENCE, {
      iat: nowSec - 7200,
      exp: nowSec - 1, // expired 1 second ago
    });
    const jwt = mintJwt(pair, payload);
    await expect(verifyIdToken(jwt, AUDIENCE, { fetchJwks })).rejects.toThrow(
      /expired/i,
    );
  });

  it('throws when iat is too old (> 24 hours)', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const payload = validPayload(AUDIENCE, {
      iat: nowSec - 25 * 3600, // 25 hours ago
      exp: nowSec + 3600, // still "valid" exp
    });
    const jwt = mintJwt(pair, payload);
    await expect(verifyIdToken(jwt, AUDIENCE, { fetchJwks })).rejects.toThrow(
      /iat is too old/i,
    );
  });

  it('throws when iat is far in the future (clock skew beyond 5 min)', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const payload = validPayload(AUDIENCE, {
      iat: nowSec + 10 * 60, // 10 minutes in the future
      exp: nowSec + 11 * 60,
    });
    const jwt = mintJwt(pair, payload);
    await expect(verifyIdToken(jwt, AUDIENCE, { fetchJwks })).rejects.toThrow(
      /iat is in the future/i,
    );
  });
});
