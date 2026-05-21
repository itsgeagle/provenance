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
  //   1. Pre-seed the row via INSERT...ON CONFLICT DO NOTHING so FOR UPDATE
  //      in the main CTE always finds an existing row to lock. This eliminates
  //      the first-request race where two concurrent new-principal requests both
  //      see no row, both compute refilled = bucketSize, and both INSERT the
  //      same starting value — resulting in one over-granted token.
  //
  //      Pre-seed uses bucketSize tokens with a far-past timestamp so the CTE
  //      computes the refill correctly:
  //       - For a brand-new principal: tokens=bucketSize, elapsed=any → min(bucketSize, ...) = bucketSize.
  //       - For an existing principal: ON CONFLICT DO NOTHING → row is unchanged.
  //
  //   2. Lock the existing row (FOR UPDATE).
  //   3. Compute refilled tokens.
  //   4. Store `refilled - 1` on allow, or `refilled` (unchanged) on deny.
  //      Storing the actual refilled value on deny (not GREATEST(0, refilled-1))
  //      is symmetric with the in-memory backend. The refill is real; the deduct
  //      just didn't happen because there weren't enough tokens.
  //   5. RETURNING includes the pre-deduct value (refilled) so we can determine
  //      whether the request was allowed.
  //
  // We use a CTE to separate the refill computation from the deduct so we can
  // access the pre-deduct value in the RETURNING clause.
  type PgRow = { tokens: number; allowed: boolean; refilled: number };

  // Pre-seed: INSERT the principal row with a full bucket and a far-past
  // last_refill_at. ON CONFLICT DO NOTHING makes this a no-op for existing
  // principals. The main CTE immediately overwrites the value.
  //
  // Why far-past timestamp? The main CTE's refill formula is:
  //   tokens + elapsed * refillRate  capped at bucketSize
  // For a new principal with tokens=bucketSize, adding any elapsed refill
  // still caps at bucketSize, so the value is correct regardless of elapsed.
  // Using a far-past timestamp maximises elapsed to ensure the LEAST() cap
  // takes effect even if the formula overflows on very large elapsed values.
  await db.execute(sql`
    INSERT INTO rate_limit_buckets (principal_id, route_class, tokens, last_refill_at)
    VALUES (
      ${principalId},
      ${routeClass},
      ${config.bucketSize}::double precision,
      '1970-01-01T00:00:00.000Z'::timestamptz
    )
    ON CONFLICT (principal_id, route_class) DO NOTHING
  `);

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
        LEAST(
          ${config.bucketSize}::double precision,
          e.tokens + EXTRACT(EPOCH FROM (${nowTs}::timestamptz - e.last_refill_at)) * 1000.0 * ${refillPerMs}
        ) AS refilled
      FROM existing e
    ),
    upserted AS (
      UPDATE rate_limit_buckets SET
        -- On allow: deduct 1. On deny: store the refilled amount (no deduct).
        -- This is symmetric with the in-memory backend: the refill is real,
        -- we just couldn't consume a token because the bucket was empty.
        tokens = CASE
          WHEN (SELECT c.refilled FROM computed c) >= 1
          THEN (SELECT c.refilled FROM computed c) - 1
          ELSE (SELECT c.refilled FROM computed c)
        END,
        last_refill_at = ${nowTs}::timestamptz
      WHERE principal_id = ${principalId}
        AND route_class = ${routeClass}
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
