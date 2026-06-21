/**
 * Rate-limit middleware (PRD §7.6).
 *
 * Token-bucket per (principal, route class). Two backends:
 *
 *   memory  — in-memory Map, correct for single-process deployments (default).
 *   postgres — `rate_limit_buckets` table, correct for multi-process deployments.
 *
 * Backend selection (see RATE_LIMIT_BACKEND in config):
 *   - If RATE_LIMIT_REDIS_URL is empty AND NODE_ENV !== 'production': memory.
 *   - Otherwise: postgres.
 *
 * Why no Redis in Phase 4? The PRD §3 env says RATE_LIMIT_REDIS_URL defaults
 * to empty. The task brief says to leave Redis for a future phase. The Postgres
 * backend is the production-correctness path when there are multiple API processes.
 *
 * Usage:
 *   router.post('/auth/google/start', rateLimit('auth'), handler)
 *
 * Response headers set on every response (success or failure):
 *   X-RateLimit-Remaining: <floor(tokens remaining)>
 *   X-RateLimit-Reset: <unix seconds when bucket will be fully refilled>
 *
 * On 429:
 *   Retry-After: <ceil(seconds until 1 token available)>
 */

import type { MiddlewareHandler, Context } from 'hono';
import type { Principal } from './auth-session.js';
import { Errors } from '../v1/errors.js';
import { getDb } from '../../db/client.js';
import { consumeTokenPg } from './rate-limit-pg.js';
import { getConfig } from '../../config/index.js';

// ---------------------------------------------------------------------------
// Route class type
// ---------------------------------------------------------------------------

export type RouteClass =
  | 'auth'
  | 'read.cohort'
  | 'read.detail'
  | 'write.config'
  | 'write.ingest'
  | 'write.ingest_part'
  | 'write.misc'
  | 'blob.download';

// ---------------------------------------------------------------------------
// Bucket configuration (PRD §7.6)
// ---------------------------------------------------------------------------

export interface BucketConfig {
  /** Maximum token capacity. */
  bucketSize: number;
  /** Number of tokens refilled per window. */
  refillCount: number;
  /** Window duration in milliseconds. */
  windowMs: number;
}

// -----------------------------------------------------------------------
// Default configs per route class (PRD §7.6 table)
// -----------------------------------------------------------------------
const BUCKET_CONFIGS: Record<RouteClass, BucketConfig> = {
  auth: { bucketSize: 30, refillCount: 30, windowMs: 5 * 60 * 1000 },
  'read.cohort': { bucketSize: 600, refillCount: 600, windowMs: 60 * 1000 },
  'read.detail': { bucketSize: 1200, refillCount: 1200, windowMs: 60 * 1000 },
  'write.config': { bucketSize: 60, refillCount: 60, windowMs: 60 * 1000 },
  'write.ingest': { bucketSize: 30, refillCount: 30, windowMs: 5 * 60 * 1000 },
  // Chunk uploads of a resumable ingest: a single multi-GB upload is hundreds of
  // PUTs, so this bucket is deliberately generous (unlike the rare write.ingest).
  'write.ingest_part': { bucketSize: 3000, refillCount: 3000, windowMs: 60 * 1000 },
  'write.misc': { bucketSize: 120, refillCount: 120, windowMs: 60 * 1000 },
  'blob.download': { bucketSize: 30, refillCount: 30, windowMs: 60 * 1000 },
};

// ---------------------------------------------------------------------------
// ConsumeResult (shared between backends)
// ---------------------------------------------------------------------------

export interface ConsumeResult {
  /** Whether the request is allowed. */
  allowed: boolean;
  /** Tokens remaining after this request (floor). */
  remaining: number;
  /** Unix seconds when the bucket will be fully refilled. */
  resetAt: number;
  /** Only present when allowed=false: seconds to wait. */
  retryAfterSeconds?: number;
}

// ---------------------------------------------------------------------------
// BucketRow (used by Postgres backend)
// ---------------------------------------------------------------------------

export interface BucketRow {
  principal_id: string;
  route_class: string;
  tokens: number;
  last_refill_at: Date;
}

// ---------------------------------------------------------------------------
// In-memory backend
// ---------------------------------------------------------------------------

interface MemoryBucket {
  tokens: number;
  lastRefillAt: number; // epoch ms
}

// Global (process-lifetime) in-memory store.
// Not exported; use _getMemoryStore() for test reset.
const _memoryStore = new Map<string, MemoryBucket>();

/** @internal — exposed for tests that need a clean store between runs. */
export function _resetMemoryStore(): void {
  _memoryStore.clear();
}

/**
 * In-memory token-bucket consume.
 *
 * Clock injection: `now` defaults to `Date.now` but can be overridden
 * in tests for deterministic refill calculations.
 */
export function consumeTokenMemory(
  principalId: string,
  routeClass: string,
  config: BucketConfig,
  now: () => number = Date.now,
): ConsumeResult {
  const key = `${principalId}:${routeClass}`;
  const nowMs = now();
  const refillPerMs = config.refillCount / config.windowMs;

  const existing = _memoryStore.get(key);

  let tokens: number;
  if (existing === undefined) {
    // First request: start full
    tokens = config.bucketSize;
  } else {
    // Refill based on elapsed time
    const elapsedMs = nowMs - existing.lastRefillAt;
    tokens = Math.min(config.bucketSize, existing.tokens + elapsedMs * refillPerMs);
  }

  if (tokens < 1) {
    // Rate limited
    const msUntilOneToken = (1 - tokens) / refillPerMs;
    const retryAfterSeconds = Math.ceil(msUntilOneToken / 1000);
    const resetAt = Math.ceil((nowMs + msUntilOneToken) / 1000);
    // Store current tokens (don't deduct below 0)
    _memoryStore.set(key, { tokens, lastRefillAt: nowMs });
    return { allowed: false, remaining: 0, retryAfterSeconds, resetAt };
  }

  // Consume one token
  const remaining = tokens - 1;
  _memoryStore.set(key, { tokens: remaining, lastRefillAt: nowMs });

  const msUntilFull = (config.bucketSize - remaining) / refillPerMs;
  const resetAt = Math.ceil((nowMs + msUntilFull) / 1000);

  return { allowed: true, remaining: Math.floor(remaining), resetAt };
}

// ---------------------------------------------------------------------------
// Principal key
// ---------------------------------------------------------------------------

function principalKey(principal: Principal | null | undefined, c: Context): string {
  if (principal === undefined || principal === null) {
    const ip = c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip') ?? 'unknown';
    return `anon:${ip}`;
  }
  if (principal.principal_kind === 'token') {
    return `token:${principal.token.id}`;
  }
  return `user:${principal.user.id}`;
}

// ---------------------------------------------------------------------------
// Backend selection
// ---------------------------------------------------------------------------

type Backend = 'memory' | 'postgres';

function selectBackend(): Backend {
  try {
    const cfg = getConfig();
    // Use memory when: RATE_LIMIT_REDIS_URL is empty AND not production.
    // Use postgres when: in production or when RATE_LIMIT_REDIS_URL is set
    // (indicating a multi-process deployment).
    if (cfg.RATE_LIMIT_REDIS_URL === '' && cfg.NODE_ENV !== 'production') {
      return 'memory';
    }
    return 'postgres';
  } catch {
    // Config not yet available (early startup or tests without config): use memory.
    return 'memory';
  }
}

// Cache the backend selection for the process lifetime.
let _backend: Backend | undefined;

function getBackend(): Backend {
  if (_backend === undefined) {
    _backend = selectBackend();
  }
  return _backend;
}

/** @internal — allows tests to force backend selection. */
export function _setBackendForTest(backend: Backend): void {
  _backend = backend;
}

/** @internal — resets the cached backend so the next call re-evaluates. */
export function _resetBackendForTest(): void {
  _backend = undefined;
}

// ---------------------------------------------------------------------------
// rateLimit middleware factory
// ---------------------------------------------------------------------------

/**
 * Returns a Hono MiddlewareHandler that enforces the token-bucket rate limit
 * for the given route class.
 *
 * Clock injection for the in-memory backend:
 *   The factory accepts an optional `now` parameter so tests can freeze time.
 *   Production code uses `Date.now`.
 *
 * Example:
 *   router.post('/auth/google/start', rateLimit('auth'), handler)
 */
export function rateLimit(routeClass: RouteClass, now: () => number = Date.now): MiddlewareHandler {
  const config = BUCKET_CONFIGS[routeClass];

  return async (c, next) => {
    const principal = c.var.principal;
    const pKey = principalKey(principal, c);
    const backend = getBackend();

    let result: ConsumeResult;
    if (backend === 'postgres') {
      const db = getDb();
      result = await consumeTokenPg(db, pKey, routeClass, config, now);
    } else {
      result = consumeTokenMemory(pKey, routeClass, config, now);
    }

    // Set rate limit headers on every response (PRD §7.7)
    c.header('X-RateLimit-Remaining', String(result.remaining));
    c.header('X-RateLimit-Reset', String(result.resetAt));

    if (!result.allowed) {
      const retryAfter = result.retryAfterSeconds ?? 1;
      c.header('Retry-After', String(retryAfter));
      const err = Errors.rateLimited(retryAfter, result.resetAt);
      return c.json(err.toBody(), 429);
    }

    await next();
  };
}
