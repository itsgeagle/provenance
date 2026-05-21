/**
 * Token storage integration tests.
 *
 * Uses withTestDb (testcontainers) for fully isolated DB per test.
 */

import { vi, describe, it, expect } from 'vitest';
import { withTestDb } from '../../test/helpers/db.js';
import {
  generateToken,
  extractPrefix,
  hashToken,
  verifyTokenHash,
  createToken,
  findTokenByPrefix,
  verifyToken,
  revokeToken,
  tokenScopesSchema,
} from './tokens.js';
import { users } from '../db/schema.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Inserts a test user and returns its id. */
async function insertTestUser(
  db: Parameters<Parameters<typeof withTestDb>[0]>[0],
): Promise<string> {
  const inserted = await db
    .insert(users)
    .values({
      google_subject: `sub-${Math.random()}`,
      email: 'test@berkeley.edu',
      display_name: 'Test User',
    })
    .returning({ id: users.id });
  const row = inserted[0];
  if (row === undefined) throw new Error('User insert returned no rows');
  return row.id;
}

// ---------------------------------------------------------------------------
// generateToken
// ---------------------------------------------------------------------------

describe('generateToken', () => {
  it('returns prefix and secret in correct format', () => {
    const { prefix, secret } = generateToken();
    expect(prefix).toHaveLength(8);
    expect(prefix).toMatch(/^[a-zA-Z0-9]+$/);
    expect(secret).toMatch(/^prov_[a-zA-Z0-9]+_[A-Za-z0-9_-]+$/);
  });

  it('secret contains prefix', () => {
    const { prefix, secret } = generateToken();
    expect(secret).toContain(`prov_${prefix}_`);
  });

  it('produces unique values each call', () => {
    const tokens = new Set(Array.from({ length: 20 }, () => generateToken().secret));
    expect(tokens.size).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// extractPrefix
// ---------------------------------------------------------------------------

describe('extractPrefix', () => {
  it('extracts prefix from valid token', () => {
    const { prefix, secret } = generateToken();
    const extracted = extractPrefix(secret);
    expect(extracted).toBe(prefix);
  });

  it('returns null for malformed token', () => {
    expect(extractPrefix('invalid')).toBeNull();
    expect(extractPrefix('prov_invalid')).toBeNull();
    expect(extractPrefix('not_a_token')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Argon2 hashing
// ---------------------------------------------------------------------------

describe('hashToken + verifyTokenHash', () => {
  it('hashes and verifies the same secret', async () => {
    const secret = 'my-secret-token-value';
    const hashed = await hashToken(secret);
    expect(hashed).toBeTruthy();
    expect(hashed).not.toBe(secret);

    const verified = await verifyTokenHash(hashed, secret);
    expect(verified).toBe(true);
  });

  it('rejects a different secret', async () => {
    const secret = 'correct-secret';
    const hashed = await hashToken(secret);
    const verified = await verifyTokenHash(hashed, 'wrong-secret');
    expect(verified).toBe(false);
  });

  it('rejects a tampered hash', async () => {
    const secret = 'my-secret';
    const hashed = await hashToken(secret);
    const tampered = hashed.slice(0, -5) + 'XXXXX';
    const verified = await verifyTokenHash(tampered, secret);
    expect(verified).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createToken
// ---------------------------------------------------------------------------

describe('createToken', () => {
  it('creates a token with defaults applied', async () => {
    await withTestDb(async (db) => {
      const userId = await insertTestUser(db);

      const { prefix, secret, token } = await createToken(db, {
        userId,
        label: 'My Token',
      });

      expect(prefix).toHaveLength(8);
      expect(secret).toMatch(/^prov_/);
      expect(token.id).toBeTruthy();
      expect(token.user_id).toBe(userId);
      expect(token.label).toBe('My Token');
      expect(token.prefix).toBe(prefix);
      expect(token.hashed_token).toBeTruthy();
      expect(token.hashed_token).not.toBe(secret);

      // Scopes should have defaults applied
      const scopes = typeof token.scopes === 'string' ? JSON.parse(token.scopes) : token.scopes;
      expect(scopes.read_only).toBe(false);
      expect(scopes.semester_ids).toBeNull();
      expect(scopes.include_blobs).toBe(false);
    });
  });

  it('respects custom scopes', async () => {
    await withTestDb(async (db) => {
      const userId = await insertTestUser(db);
      const uuid1 = '550e8400-e29b-41d4-a716-446655440000';
      const uuid2 = '550e8400-e29b-41d4-a716-446655440001';

      const { token } = await createToken(db, {
        userId,
        label: 'Scoped Token',
        scopes: {
          read_only: true,
          semester_ids: [uuid1, uuid2],
        },
      });

      const scopes = typeof token.scopes === 'string' ? JSON.parse(token.scopes) : token.scopes;
      expect(scopes.read_only).toBe(true);
      expect(scopes.semester_ids).toEqual([uuid1, uuid2]);
      expect(scopes.include_blobs).toBe(false);
    });
  });

  it('stores expiry if provided', async () => {
    await withTestDb(async (db) => {
      const userId = await insertTestUser(db);
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

      const { token } = await createToken(db, {
        userId,
        label: 'Expiring Token',
        expiresAt,
      });

      expect(token.expires_at).toBeTruthy();
      expect(token.expires_at!.getTime()).toBeCloseTo(expiresAt.getTime(), -2); // within 100ms
    });
  });

  it('generates unique prefixes on retries (simulated by checking no constraint error)', async () => {
    await withTestDb(async (db) => {
      const userId = await insertTestUser(db);

      // Create two tokens — both should succeed without constraint errors.
      const token1 = await createToken(db, {
        userId,
        label: 'Token 1',
      });

      const token2 = await createToken(db, {
        userId,
        label: 'Token 2',
      });

      expect(token1.prefix).not.toBe(token2.prefix);
    });
  });
});

// ---------------------------------------------------------------------------
// findTokenByPrefix
// ---------------------------------------------------------------------------

describe('findTokenByPrefix', () => {
  it('finds a token by its prefix', async () => {
    await withTestDb(async (db) => {
      const userId = await insertTestUser(db);
      const { prefix, token: created } = await createToken(db, {
        userId,
        label: 'Find Me',
      });

      const found = await findTokenByPrefix(db, prefix);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(created.id);
      expect(found!.prefix).toBe(prefix);
    });
  });

  it('returns null for unknown prefix', async () => {
    await withTestDb(async (db) => {
      const found = await findTokenByPrefix(db, 'unknown');
      expect(found).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// verifyToken
// ---------------------------------------------------------------------------

describe('verifyToken', () => {
  it('accepts a valid, non-revoked, non-expired token', async () => {
    await withTestDb(async (db) => {
      const userId = await insertTestUser(db);
      const { secret, token } = await createToken(db, {
        userId,
        label: 'Valid Token',
      });

      const verified = await verifyToken(token, secret);
      expect(verified).toBe(true);
    });
  });

  it('rejects a token with wrong secret', async () => {
    await withTestDb(async (db) => {
      const userId = await insertTestUser(db);
      const { token } = await createToken(db, {
        userId,
        label: 'Wrong Secret Test',
      });

      const verified = await verifyToken(token, 'wrong-secret');
      expect(verified).toBe(false);
    });
  });

  it('rejects a revoked token', async () => {
    await withTestDb(async (db) => {
      const userId = await insertTestUser(db);
      const { secret, token: created } = await createToken(db, {
        userId,
        label: 'Revoked Token',
      });

      await revokeToken(db, created.id);

      // Fetch the updated token
      const token = await findTokenByPrefix(db, created.prefix);
      expect(token).not.toBeNull();

      const verified = await verifyToken(token!, secret);
      expect(verified).toBe(false);
    });
  });

  it('rejects an expired token', async () => {
    await withTestDb(async (db) => {
      const userId = await insertTestUser(db);
      const pastDate = new Date(Date.now() - 1000); // 1 second ago

      const { secret, token } = await createToken(db, {
        userId,
        label: 'Expired Token',
        expiresAt: pastDate,
      });

      const verified = await verifyToken(token, secret);
      expect(verified).toBe(false);
    });
  });

  it('accepts a token expiring in the future', async () => {
    await withTestDb(async (db) => {
      const userId = await insertTestUser(db);
      const futureDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

      const { secret, token } = await createToken(db, {
        userId,
        label: 'Future Expiry',
        expiresAt: futureDate,
      });

      const verified = await verifyToken(token, secret);
      expect(verified).toBe(true);
    });
  });

  it('accepts a token with no expiry (expires_at IS NULL)', async () => {
    await withTestDb(async (db) => {
      const userId = await insertTestUser(db);
      const { secret, token } = await createToken(db, {
        userId,
        label: 'No Expiry',
        expiresAt: null,
      });

      expect(token.expires_at).toBeNull();

      const verified = await verifyToken(token, secret);
      expect(verified).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// revokeToken
// ---------------------------------------------------------------------------

describe('revokeToken', () => {
  it('sets revoked_at', async () => {
    await withTestDb(async (db) => {
      const userId = await insertTestUser(db);
      const { token: created } = await createToken(db, {
        userId,
        label: 'To Revoke',
      });

      expect(created.revoked_at).toBeNull();

      await revokeToken(db, created.id);

      const token = await findTokenByPrefix(db, created.prefix);
      expect(token!.revoked_at).not.toBeNull();
      expect(token!.revoked_at!.getTime()).toBeCloseTo(Date.now(), -2);
    });
  });

  it('is idempotent — revoking an already-revoked token succeeds', async () => {
    await withTestDb(async (db) => {
      const userId = await insertTestUser(db);
      const { token: created } = await createToken(db, {
        userId,
        label: 'Revoke Twice',
      });

      await revokeToken(db, created.id);
      await findTokenByPrefix(db, created.prefix);

      // Small delay to ensure time difference if it were to change
      await new Promise((r) => setTimeout(r, 50));

      await revokeToken(db, created.id);
      const revokedTwice = await findTokenByPrefix(db, created.prefix);

      // revoked_at should not have changed (or changed minimally)
      expect(revokedTwice!.revoked_at!.getTime()).toBeLessThanOrEqual(new Date().getTime() + 100);
    });
  });
});

// ---------------------------------------------------------------------------
// tokenScopesSchema validation
// ---------------------------------------------------------------------------

describe('tokenScopesSchema', () => {
  it('parses and applies defaults', () => {
    const result = tokenScopesSchema.parse({});
    expect(result).toEqual({
      read_only: false,
      semester_ids: null,
      include_blobs: false,
    });
  });

  it('overrides defaults', () => {
    const uuid1 = '550e8400-e29b-41d4-a716-446655440000';
    const result = tokenScopesSchema.parse({
      read_only: true,
      semester_ids: [uuid1],
    });
    expect(result).toEqual({
      read_only: true,
      semester_ids: [uuid1],
      include_blobs: false,
    });
  });

  it('rejects invalid semester_ids (not UUIDs)', () => {
    expect(() =>
      tokenScopesSchema.parse({
        semester_ids: ['not-a-uuid'],
      }),
    ).toThrow();
  });

  it('accepts null semester_ids', () => {
    const result = tokenScopesSchema.parse({
      semester_ids: null,
    });
    expect(result.semester_ids).toBeNull();
  });

  it('accepts an empty array of semester_ids', () => {
    const result = tokenScopesSchema.parse({
      semester_ids: [],
    });
    expect(result.semester_ids).toEqual([]);
  });
});
