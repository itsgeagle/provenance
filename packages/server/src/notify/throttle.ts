/**
 * Per-key throttle with a sliding "last sent" window, so repeated events (a
 * crash loop, a wedged retrying job) don't spam push sinks. The first call
 * for a key — or the first call after `windowMs` has elapsed since the last
 * admitted call — is admitted and resets the suppressed counter; calls
 * within the window are suppressed and the counter increments.
 *
 * Keys are LRU-capped at `maxKeys`: the `Map` is used as an LRU (touch =
 * delete + re-set, so the most-recently-touched key is always last), and the
 * oldest key (the first one in iteration order) is evicted when the map
 * grows past the cap. An evicted key is treated as brand new on next admit.
 */
export class Throttler {
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly maxKeys: number;
  private readonly entries = new Map<string, { lastSent: number; suppressed: number }>();

  constructor(opts: { windowMs: number; now: () => number; maxKeys?: number }) {
    this.windowMs = opts.windowMs;
    this.now = opts.now;
    this.maxKeys = opts.maxKeys ?? 1000;
  }

  admit(key: string): { send: boolean; suppressed: number } {
    const t = this.now();
    const existing = this.entries.get(key);
    if (existing) {
      // Touch: remove so the re-set below moves it to the most-recently-used
      // position (end of Map iteration order).
      this.entries.delete(key);
    }

    if (!existing || t - existing.lastSent >= this.windowMs) {
      const suppressed = existing?.suppressed ?? 0;
      this.entries.set(key, { lastSent: t, suppressed: 0 });
      this.evictIfOverCap();
      return { send: true, suppressed };
    }

    const suppressed = existing.suppressed + 1;
    this.entries.set(key, { lastSent: existing.lastSent, suppressed });
    this.evictIfOverCap();
    return { send: false, suppressed };
  }

  private evictIfOverCap(): void {
    while (this.entries.size > this.maxKeys) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      this.entries.delete(oldestKey);
    }
  }
}
