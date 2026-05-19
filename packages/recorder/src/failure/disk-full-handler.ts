/**
 * DiskFullHandler — handles ENOSPC and similar write errors.
 *
 * PRD §4.8 disk-full row:
 *   "Surface a notification; switch to a tiny in-memory ring buffer for critical
 *    events only; emit `recorder.degraded` event."
 *
 * Design:
 * - Once degraded, only CRITICAL_KINDS entries are kept (ring buffer, fixed capacity).
 * - handleWriteError is idempotent: the first error triggers the transition; subsequent
 *   calls are no-ops. This is safe even if the `recorder.degraded` event itself fails
 *   to write (it will be enqueued in the ring).
 * - Ring eviction: oldest entry is dropped when the ring is full (FIFO).
 */

import type { HashedEnvelope, EventKind } from '@provenance/log-core';

export type DiskFullHandlerDeps = {
  /** Capacity of the critical-only ring buffer (count of entries). Default 256. */
  ringCapacity?: number;
  /** Called once when we first transition into degraded state. */
  onDegraded: (data: { reason: string }) => void;
  /** Surface a UI notification to the user. */
  notify: (message: string) => void;
};

/** Event kinds that are retained in degraded mode. All others are dropped. */
export const CRITICAL_KINDS: ReadonlySet<EventKind> = new Set<EventKind>([
  'session.start',
  'session.end',
  'fs.external_change',
  'chain.broken',
  'recorder.degraded',
  'recorder.recovered_from_corruption',
]);

const DEFAULT_RING_CAPACITY = 256;

export class DiskFullHandler {
  private _degraded = false;
  private readonly ringCapacity: number;
  private readonly _onDegraded: (data: { reason: string }) => void;
  private readonly _notify: (message: string) => void;
  private readonly ring: HashedEnvelope[] = [];

  constructor(deps: DiskFullHandlerDeps) {
    this.ringCapacity = deps.ringCapacity ?? DEFAULT_RING_CAPACITY;
    this._onDegraded = deps.onDegraded;
    this._notify = deps.notify;
  }

  /** True if we've transitioned into degraded mode. */
  get degraded(): boolean {
    return this._degraded;
  }

  /**
   * Called by the writer's onError hook.
   * Triggers degraded mode on first call; subsequent calls are no-ops (idempotent).
   * Any write error (ENOSPC or otherwise) is treated as disk-full for v1.
   */
  handleWriteError(_error: NodeJS.ErrnoException | Error): void {
    if (this._degraded) {
      // Already in degraded mode — idempotent.
      return;
    }

    this._degraded = true;

    // Notify the user.
    this._notify('Disk full — Provenance recording is degraded. Free space and restart VS Code.');

    // Signal callers to emit recorder.degraded. The emitted event will come back
    // through enqueue() — it will be accepted into the ring because its kind is critical.
    this._onDegraded({ reason: 'disk_full' });
  }

  /**
   * When degraded: if the entry's kind is in CRITICAL_KINDS, push it into the ring
   * (evicting the oldest if full) and return true.
   * If not degraded, or if the kind is non-critical, return false — caller drops.
   */
  enqueue(entry: HashedEnvelope): boolean {
    if (!this._degraded) {
      return false;
    }

    if (!CRITICAL_KINDS.has(entry.kind)) {
      return false;
    }

    // Evict oldest if at capacity.
    if (this.ring.length >= this.ringCapacity) {
      this.ring.shift();
    }

    this.ring.push(entry);
    return true;
  }

  /**
   * Return a shallow copy of the ring buffer contents.
   * Mutating the returned array does not affect internal state.
   */
  snapshot(): HashedEnvelope[] {
    return [...this.ring];
  }
}
