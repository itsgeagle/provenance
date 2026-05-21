/**
 * Unit tests for the JWKs cache module.
 *
 * All tests use a mock fetch; no real network calls are made.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getGoogleJwks,
  findKeyByKid,
  _resetJwksCacheForTest,
  _expireCacheForTest,
  type JwkSet,
} from './jwks.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const FAKE_JWKS: JwkSet = {
  keys: [
    { kty: 'RSA', kid: 'key-1', alg: 'RS256', use: 'sig', n: 'abc', e: 'AQAB' },
    { kty: 'RSA', kid: 'key-2', alg: 'RS256', use: 'sig', n: 'def', e: 'AQAB' },
  ],
};

const FAKE_JWKS_V2: JwkSet = {
  keys: [{ kty: 'RSA', kid: 'key-3', alg: 'RS256', use: 'sig', n: 'ghi', e: 'AQAB' }],
};

function makeFetchMock(jwks: JwkSet, maxAgeSec = 3600): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({
    ok: true,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'cache-control' ? `max-age=${maxAgeSec}` : null,
    },
    json: () => Promise.resolve(jwks),
  } as unknown as Response);
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let origFetch: any;

beforeEach(() => {
  _resetJwksCacheForTest();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  origFetch = (globalThis as any).fetch;
});

afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = origFetch;
  _resetJwksCacheForTest();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Cache tests
// ---------------------------------------------------------------------------

describe('getGoogleJwks — cache behaviour', () => {
  it('fetches from network on first call', async () => {
    const mockFetch = makeFetchMock(FAKE_JWKS);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = mockFetch;

    const result = await getGoogleJwks();
    expect(result).toEqual(FAKE_JWKS);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('returns cached value on second call within TTL', async () => {
    const mockFetch = makeFetchMock(FAKE_JWKS);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = mockFetch;

    await getGoogleJwks();
    const result = await getGoogleJwks();

    expect(result).toEqual(FAKE_JWKS);
    // Only one real fetch despite two calls.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('refetches after TTL expiry', async () => {
    // First call — populates the cache.
    const mockFetch = makeFetchMock(FAKE_JWKS);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = mockFetch;
    await getGoogleJwks();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Simulate TTL expiry by forcing the cache entry to be stale.
    // We use _expireCacheForTest() rather than fake timers because
    // vi.useFakeTimers() does not reliably intercept Date.now() across
    // ESM module boundaries in Vitest's worker model.
    _expireCacheForTest();

    // Second call — cache stale, should refetch with new response.
    mockFetch.mockResolvedValue({
      ok: true,
      headers: { get: () => 'max-age=3600' },
      json: () => Promise.resolve(FAKE_JWKS_V2),
    } as unknown as Response);

    const result = await getGoogleJwks();
    expect(result).toEqual(FAKE_JWKS_V2);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('concurrent callers share a single in-flight fetch (no stampede)', async () => {
    let resolveFetch!: (r: Response) => void;
    const fetchPromise = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const mockFetch = vi.fn().mockReturnValue(fetchPromise);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = mockFetch;

    // Launch two concurrent calls before the fetch resolves.
    const p1 = getGoogleJwks();
    const p2 = getGoogleJwks();

    // Resolve the single in-flight fetch.
    resolveFetch({
      ok: true,
      headers: { get: () => 'max-age=3600' },
      json: () => Promise.resolve(FAKE_JWKS),
    } as unknown as Response);

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual(FAKE_JWKS);
    expect(r2).toEqual(FAKE_JWKS);
    // Only one actual HTTP request.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// findKeyByKid
// ---------------------------------------------------------------------------

describe('findKeyByKid', () => {
  it('returns the matching key by kid', () => {
    const found = findKeyByKid(FAKE_JWKS, 'key-1');
    expect(found).toBeDefined();
    expect(found!.kid).toBe('key-1');
    expect(found!.n).toBe('abc');
  });

  it('returns the second key when kid matches key-2', () => {
    const found = findKeyByKid(FAKE_JWKS, 'key-2');
    expect(found).toBeDefined();
    expect(found!.kid).toBe('key-2');
  });

  it('returns undefined for an unknown kid', () => {
    const found = findKeyByKid(FAKE_JWKS, 'does-not-exist');
    expect(found).toBeUndefined();
  });

  it('returns undefined on empty key set', () => {
    const emptySet: JwkSet = { keys: [] };
    expect(findKeyByKid(emptySet, 'key-1')).toBeUndefined();
  });
});
