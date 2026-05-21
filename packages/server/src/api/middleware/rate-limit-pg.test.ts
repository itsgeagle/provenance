/**
 * Rate limit middleware tests — Postgres backend.
 *
 * Uses withTestDb and clock injection for deterministic refill behavior.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { withTestDb } from '../../../test/helpers/db.js';
import { consumeTokenPg } from './rate-limit-pg.js';
import { _resetConfigForTest, _setConfigForTest } from '../../config/index.js';
import { _resetLoggerForTest } from '../../logging.js';
import { parseEnv } from '../../config/env.js';
import type { BucketConfig } from './rate-limit.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// ---------------------------------------------------------------------------
// Test env
// ---------------------------------------------------------------------------

const BASE_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  PUBLIC_BASE_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgres://user:pass@localhost:5432/provenance',
  OBJECT_STORAGE_ENDPOINT: 'http://localhost:9000',
  OBJECT_STORAGE_BUCKET: 'provenance',
  OBJECT_STORAGE_ACCESS_KEY_ID: 'minioadmin',
  OBJECT_STORAGE_SECRET_ACCESS_KEY: 'minioadmin',
  GOOGLE_OAUTH_CLIENT_ID: 'client-id',
  GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
  AUTH_ALLOWED_HOSTED_DOMAINS: '["berkeley.edu"]',
  AUTH_SUPERADMIN_EMAILS: '["admin@berkeley.edu"]',
  AUTH_COOKIE_SIGNING_SECRET: 'test-signing-secret-rate-limit-pg-tests-abcde',
  SESSION_TTL_DAYS: '14',
};

beforeEach(() => {
  _resetConfigForTest();
  _resetLoggerForTest();
  _setConfigForTest(parseEnv(BASE_ENV));
});

// ---------------------------------------------------------------------------
// Config for tests (small bucket for speed)
// ---------------------------------------------------------------------------

const testConfig: BucketConfig = {
  bucketSize: 5,
  refillCount: 5,
  windowMs: 60_000, // 1 minute
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('consumeTokenPg (Postgres backend)', () => {
  it('allows up to bucket size requests then denies', async () => {
    await withTestDb(async (db) => {
      const fakeNow = Date.now();
      const principalId = `user:${crypto.randomUUID()}`;

      for (let i = 0; i < 5; i++) {
        const result = await consumeTokenPg(db, principalId, 'test.class', testConfig, () => fakeNow);
        expect(result.allowed).toBe(true);
      }

      // 6th should be denied
      const denied = await consumeTokenPg(db, principalId, 'test.class', testConfig, () => fakeNow);
      expect(denied.allowed).toBe(false);
      expect(denied.remaining).toBe(0);
    });
  });

  it('denied result includes retryAfterSeconds', async () => {
    await withTestDb(async (db) => {
      const fakeNow = Date.now();
      const principalId = `user:${crypto.randomUUID()}`;

      // Exhaust
      for (let i = 0; i < 5; i++) {
        await consumeTokenPg(db, principalId, 'test.class', testConfig, () => fakeNow);
      }
      const denied = await consumeTokenPg(db, principalId, 'test.class', testConfig, () => fakeNow);
      expect(denied.allowed).toBe(false);
      expect(denied.retryAfterSeconds).toBeGreaterThan(0);
    });
  });

  it('bucket refills after time passes', async () => {
    await withTestDb(async (db) => {
      let fakeNow = Date.now();
      const principalId = `user:${crypto.randomUUID()}`;

      // Exhaust
      for (let i = 0; i < 5; i++) {
        await consumeTokenPg(db, principalId, 'test.class', testConfig, () => fakeNow);
      }

      // Advance by full window (1 minute = full refill)
      fakeNow += 60_000;

      const result = await consumeTokenPg(db, principalId, 'test.class', testConfig, () => fakeNow);
      expect(result.allowed).toBe(true);
    });
  });

  it('different principals do not share buckets', async () => {
    await withTestDb(async (db) => {
      const fakeNow = Date.now();
      const principalId1 = `user:${crypto.randomUUID()}`;
      const principalId2 = `user:${crypto.randomUUID()}`;

      // Exhaust principal 1
      for (let i = 0; i < 5; i++) {
        await consumeTokenPg(db, principalId1, 'test.class', testConfig, () => fakeNow);
      }
      const denied = await consumeTokenPg(db, principalId1, 'test.class', testConfig, () => fakeNow);
      expect(denied.allowed).toBe(false);

      // Principal 2 should have its own full bucket
      const allowed = await consumeTokenPg(db, principalId2, 'test.class', testConfig, () => fakeNow);
      expect(allowed.allowed).toBe(true);
    });
  });

  it('concurrent requests do not double-spend (atomic upsert)', async () => {
    await withTestDb(async (db) => {
      const fakeNow = Date.now();
      const principalId = `user:${crypto.randomUUID()}`;

      // Send 6 concurrent requests against a 5-token bucket.
      // At most 5 should be allowed; at least 1 must be denied.
      const results = await Promise.all(
        Array.from({ length: 6 }).map(() =>
          consumeTokenPg(db, principalId, 'test.class', testConfig, () => fakeNow),
        ),
      );

      const allowedCount = results.filter((r) => r.allowed).length;
      const deniedCount = results.filter((r) => !r.allowed).length;

      // Due to atomic upsert, total consumed ≤ bucketSize
      expect(allowedCount).toBeLessThanOrEqual(5);
      expect(deniedCount).toBeGreaterThanOrEqual(1);
      expect(allowedCount + deniedCount).toBe(6);
    });
  });

  it('returns resetAt as future unix timestamp', async () => {
    await withTestDb(async (db) => {
      const fakeNow = Date.now();
      const principalId = `user:${crypto.randomUUID()}`;

      const result = await consumeTokenPg(db, principalId, 'test.class', testConfig, () => fakeNow);
      expect(result.resetAt).toBeGreaterThan(Math.floor(fakeNow / 1000));
    });
  });
});
