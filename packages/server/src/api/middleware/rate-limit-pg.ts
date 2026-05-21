/**
 * Postgres-backed rate limit backend.
 *
 * Uses token-bucket algorithm with continuous refill, backed by the
 * `rate_limit_buckets` table. Atomic upsert prevents double-spend across
 * concurrent requests in multi-process deployments.
 *
 * Used when RATE_LIMIT_BACKEND=postgres (production default when
 * RATE_LIMIT_REDIS_URL is empty but NODE_ENV=production).
 *
 * Each call is one Postgres round-trip (an upsert + RETURNING).
 */

import { sql } from 'drizzle-orm';
import type { DrizzleDb } from '../../db/client.js';
import type { BucketConfig, ConsumeResult } from './rate-limit.js';

/**
 * Atomically refills and consumes one token from the Postgres bucket.
 *
 * Algorithm (single CTE for correctness):
 *   1. Compute the refilled token count (capped at bucket_size) without deducting.
 *   2. If refilled >= 1: deduct 1, store, return ALLOW.
 *   3. Else: store unchanged (don't go below 0), return DENY.
 *
 * Uses a CTE so we can reference the pre-deduct token count in both the
 * UPDATE logic and the RETURNING clause without Postgres's RETURNING-references-
 * post-update ambiguity.
 *
 * Clock injection: `now` defaults to `Date.now` but can be overridden in
 * tests for deterministic behaviour.
 */
export async function consumeTokenPg(
  db: DrizzleDb,
  principalId: string,
  routeClass: string,
  config: BucketConfig,
  now: () => number = Date.now,
): Promise<ConsumeResult> {
  const nowMs = now();
  const nowTs = new Date(nowMs).toISOString();

  // Compute refill rate in tokens per millisecond
  const refillPerMs = config.refillCount / config.windowMs;

  // CTE-based upsert:
  //   1. Try to lock the existing row (FOR UPDATE).
  //   2. If it exists, compute refilled tokens.
  //   3. Deduct 1 if available; clamp to 0 otherwise.
  //   4. Upsert.
  //   5. RETURNING includes the pre-deduct value so we can determine if allowed.
  //
  // We use a CTE to separate the refill computation from the deduct so we can
  // access the pre-deduct value in the RETURNING clause.
  type PgRow = { tokens: number; allowed: boolean; refilled: number };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle's execute() requires Record<string,unknown> but we know the exact shape
  const rows = await db.execute<any>(sql`
    WITH existing AS (
      SELECT tokens, last_refill_at
      FROM rate_limit_buckets
      WHERE principal_id = ${principalId}
        AND route_class = ${routeClass}
      FOR UPDATE
    ),
    computed AS (
      SELECT
        COALESCE(
          LEAST(
            ${config.bucketSize}::double precision,
            e.tokens + EXTRACT(EPOCH FROM (${nowTs}::timestamptz - e.last_refill_at)) * 1000.0 * ${refillPerMs}
          ),
          ${config.bucketSize}::double precision  -- no existing row → full bucket
        ) AS refilled
      FROM (SELECT 1) AS dummy
      LEFT JOIN existing e ON true
    ),
    upserted AS (
      INSERT INTO rate_limit_buckets (principal_id, route_class, tokens, last_refill_at)
      SELECT
        ${principalId},
        ${routeClass},
        GREATEST(0, c.refilled - 1),
        ${nowTs}::timestamptz
      FROM computed c
      ON CONFLICT (principal_id, route_class) DO UPDATE SET
        tokens = GREATEST(0, (SELECT c.refilled FROM computed c) - 1),
        last_refill_at = ${nowTs}::timestamptz
      RETURNING tokens
    )
    SELECT
      u.tokens,
      c.refilled >= 1 AS allowed,
      c.refilled
    FROM upserted u, computed c
  `);

  const rowArray = rows as unknown as PgRow[];
  const row = rowArray[0];

  if (row === undefined) {
    // Should never happen — the CTE always produces a row.
    return {
      allowed: true,
      remaining: config.bucketSize - 1,
      resetAt: Math.ceil((nowMs + config.windowMs) / 1000),
    };
  }

  if (!row.allowed) {
    // Bucket was empty — rate limited
    const tokensAvailable = row.refilled; // < 1
    const msUntilOneToken = (1 - tokensAvailable) / refillPerMs;
    const retryAfterSeconds = Math.ceil(msUntilOneToken / 1000);
    const resetAt = Math.ceil((nowMs + msUntilOneToken) / 1000);
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds,
      resetAt,
    };
  }

  // Full bucket refill time (for X-RateLimit-Reset)
  const tokensAfterDeduct = row.tokens;
  const msUntilFull = (config.bucketSize - tokensAfterDeduct) / refillPerMs;
  const resetAt = Math.ceil((nowMs + msUntilFull) / 1000);

  return {
    allowed: true,
    remaining: Math.floor(tokensAfterDeduct),
    resetAt,
  };
}
