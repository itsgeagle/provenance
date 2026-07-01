/**
 * Minimal hand-rolled LRU cache (Map-based, insertion-order eviction).
 *
 * Uses Map's insertion-order iteration property (ECMA §23.1.3.5): the oldest
 * entry is always `map.keys().next().value`. On access, the entry is deleted
 * and re-inserted to move it to the most-recent tail.
 *
 * No external dependency (lru-cache is not in the server deps; adding it needs
 * explicit approval per CLAUDE.md). Shared by the file-reconstruction cache and
 * the parsed-bundle index cache.
 */
export class LruCache<K, V> {
  private readonly capacity: number;
  private readonly map: Map<K, V>;

  constructor(capacity: number) {
    if (capacity < 1) throw new RangeError('LruCache capacity must be >= 1');
    this.capacity = capacity;
    this.map = new Map();
  }

  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    // Re-insert to mark as most recently used.
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.capacity) {
      // Evict the least-recently-used (first) entry.
      const lruKey = this.map.keys().next().value as K;
      this.map.delete(lruKey);
    }
  }

  /** Delete a key (no-op if absent). */
  delete(key: K): void {
    this.map.delete(key);
  }

  /** Current cache size. Exposed for tests. */
  get size(): number {
    return this.map.size;
  }
}
