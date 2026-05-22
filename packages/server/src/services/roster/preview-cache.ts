/**
 * In-memory preview cache for roster upload previews (PRD §8.4).
 *
 * Keyed by `upload_id` (UUID). TTL: 30 minutes. Lazy eviction on each get.
 * A server reboot forfeits all in-flight previews — acceptable for v3.0.
 *
 * The `now` parameter on getPreview is injectable for testing.
 */

import type { ParsedRow } from './parse.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CachedPreview {
  semesterId: string;
  toAdd: ParsedRow[];
  toUpdate: { existingId: string; row: ParsedRow }[];
  toDelete: { existingId: string; sid: string }[];
  createdAt: number; // ms epoch
}

// ---------------------------------------------------------------------------
// Module-level store
// ---------------------------------------------------------------------------

const TTL_MS = 30 * 60 * 1000; // 30 minutes

// Exported for inspection in tests; not part of the public API.
const _cache = new Map<string, CachedPreview>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Store a preview. Overwrites any existing entry for the same upload_id.
 */
export function putPreview(uploadId: string, preview: CachedPreview): void {
  _cache.set(uploadId, preview);
}

/**
 * Retrieve a preview by upload_id. Returns null if missing or expired.
 *
 * Sweeps expired entries on each call (lazy eviction).
 *
 * @param uploadId - UUID string.
 * @param now      - Optional clock injection for tests. Defaults to Date.now().
 */
export function getPreview(uploadId: string, now: () => number = Date.now): CachedPreview | null {
  const ts = now();

  // Lazy eviction: remove all expired entries.
  for (const [key, entry] of _cache) {
    if (ts - entry.createdAt >= TTL_MS) {
      _cache.delete(key);
    }
  }

  const entry = _cache.get(uploadId);
  if (entry === undefined) return null;
  return entry;
}

/**
 * Reset the cache for tests. Not for production use.
 * @internal
 */
export function _resetPreviewCacheForTest(): void {
  _cache.clear();
}
