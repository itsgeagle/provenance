/**
 * Google JWKs (JSON Web Key Set) fetch + cache.
 *
 * Google's public keys rotate periodically. We cache the JWKs response
 * and honor the `max-age` directive from the `Cache-Control` header (or fall
 * back to a 1-hour minimum as a safe floor).
 *
 * Concurrent callers during a cache miss share a single in-flight fetch via a
 * module-level `Promise<JWKs> | undefined` variable. Once resolved, the cache
 * entry is set and all callers receive the same key set.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// JWK shape
// ---------------------------------------------------------------------------

const JwkSchema = z.object({
  kty: z.literal('RSA'),
  use: z.string().optional(),
  alg: z.string().optional(),
  kid: z.string(),
  n: z.string(),
  e: z.string(),
});

const JwksSchema = z.object({
  keys: z.array(JwkSchema),
});

export type Jwk = z.infer<typeof JwkSchema>;
export type JwkSet = z.infer<typeof JwksSchema>;

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const GOOGLE_JWKS_URI = 'https://www.googleapis.com/oauth2/v3/certs';
const MIN_TTL_MS = 60 * 60 * 1000; // 1 hour floor

interface CacheEntry {
  keys: JwkSet;
  expiresAt: number; // Date.now() + TTL
}

let _cache: CacheEntry | undefined;
let _inflight: Promise<JwkSet> | undefined;

/**
 * Resets cache and in-flight state. For tests only.
 * Not exported from the package's public surface.
 */
export function _resetJwksCacheForTest(): void {
  _cache = undefined;
  _inflight = undefined;
}

/**
 * Forces the cache to appear expired (sets expiresAt to a past timestamp).
 * For tests only — lets tests verify refetch behaviour without needing to
 * control `Date.now()` across module boundaries.
 */
export function _expireCacheForTest(): void {
  if (_cache !== undefined) {
    _cache = { keys: _cache.keys, expiresAt: 0 };
  }
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

/**
 * Performs a single fetch of Google's JWKs, validates the shape, and parses
 * the Cache-Control max-age to determine the TTL.
 */
async function fetchJwksFromGoogle(): Promise<JwkSet> {
  const res = await fetch(GOOGLE_JWKS_URI);
  if (!res.ok) {
    throw new Error(`Failed to fetch Google JWKs: HTTP ${res.status}`);
  }

  // Determine TTL from Cache-Control: max-age=N header.
  let ttlMs = MIN_TTL_MS;
  const cc = res.headers.get('cache-control');
  if (cc !== null) {
    const match = /max-age=(\d+)/i.exec(cc);
    if (match !== null && match[1] !== undefined) {
      const maxAgeSeconds = parseInt(match[1], 10);
      if (!isNaN(maxAgeSeconds)) {
        ttlMs = Math.max(maxAgeSeconds * 1000, MIN_TTL_MS);
      }
    }
  }

  const body: unknown = await res.json();
  const parsed = JwksSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(`Unexpected Google JWKs response shape: ${parsed.error.message}`);
  }

  _cache = { keys: parsed.data, expiresAt: Date.now() + ttlMs };
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the current Google JWKs, using the cache when valid.
 *
 * Concurrent callers during a cache miss share a single in-flight Promise
 * (no stampede).
 */
export async function getGoogleJwks(): Promise<JwkSet> {
  // Cache hit.
  if (_cache !== undefined && Date.now() < _cache.expiresAt) {
    return _cache.keys;
  }

  // Cache miss — share one in-flight fetch.
  if (_inflight !== undefined) {
    return _inflight;
  }

  _inflight = fetchJwksFromGoogle().finally(() => {
    _inflight = undefined;
  });
  return _inflight;
}

/**
 * Finds a JWK by `kid` in `keys`. Returns `undefined` if not found.
 */
export function findKeyByKid(keys: JwkSet, kid: string): Jwk | undefined {
  return keys.keys.find((k) => k.kid === kid);
}
