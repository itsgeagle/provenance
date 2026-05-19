/**
 * Unit tests for DiskFullHandler.
 *
 * Tests:
 * - handleWriteError with ENOSPC → degraded=true, onDegraded called once, notify called once.
 * - handleWriteError second call doesn't re-fire (idempotent).
 * - After degraded: enqueue(critical) → true, ring contains entry.
 * - After degraded: enqueue(non-critical) → false, ring unchanged.
 * - Ring eviction: enqueue capacity+1 critical entries → oldest dropped.
 * - snapshot() returns a copy; mutating it doesn't change internal ring.
 * - enqueue returns false when not yet degraded.
 */

import { describe, it, expect, vi } from 'vitest';
import { DiskFullHandler, CRITICAL_KINDS } from './disk-full-handler.js';
import { chainEntry, GENESIS_PREV_HASH, sha256Hex } from '@provenance/log-core';
import type { HashedEnvelope, EventKind } from '@provenance/log-core';

// ---------------------------------------------------------------------------
// Helper: build a minimal HashedEnvelope for a given kind.
// ---------------------------------------------------------------------------

function makeEntry(
  kind: EventKind,
  seq: number,
  prevHash: string = GENESIS_PREV_HASH,
): HashedEnvelope {
  // Use chainEntry so the entry has a valid hash; data values are minimal.
  const envelope = {
    seq,
    t: seq * 100,
    wall: `2026-01-01T00:00:${String(seq).padStart(2, '0')}.000Z`,
    kind,
    // Minimal valid data for each kind — we only care about the kind field here.
    data:
      kind === 'session.end'
        ? { reason: 'deactivate' as const }
        : kind === 'session.start'
          ? ({} as never) // tests don't validate payload shape
          : kind === 'fs.external_change'
            ? { path: 'hw.py', old_hash: 'a'.repeat(64), new_hash: 'b'.repeat(64), diff_size: 0 }
            : kind === 'chain.broken'
              ? { break_at_seq: seq, reason: 'hash_mismatch' as const }
              : kind === 'recorder.degraded'
                ? { reason: 'disk_full' }
                : kind === 'recorder.recovered_from_corruption'
                  ? { quarantined_path: '/tmp/x.slog.corrupt' }
                  : kind === 'doc.change'
                    ? { path: 'hw.py', deltas: [], source: 'typed' as const }
                    : kind === 'doc.open'
                      ? { path: 'hw.py', sha256: 'a'.repeat(64), line_count: 10 }
                      : {},
  };
  return chainEntry(prevHash, envelope as Parameters<typeof chainEntry>[1], sha256Hex);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DiskFullHandler', () => {
  describe('handleWriteError', () => {
    it('transitions to degraded on first ENOSPC error', () => {
      const onDegraded = vi.fn();
      const notify = vi.fn();
      const handler = new DiskFullHandler({ onDegraded, notify });

      expect(handler.degraded).toBe(false);

      const err = Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
      handler.handleWriteError(err);

      expect(handler.degraded).toBe(true);
      expect(onDegraded).toHaveBeenCalledTimes(1);
      expect(onDegraded).toHaveBeenCalledWith({ reason: 'disk_full' });
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledWith(
        'Disk full — Provenance recording is degraded. Free space and restart VS Code.',
      );
    });

    it('handles any write error (not just ENOSPC)', () => {
      const onDegraded = vi.fn();
      const notify = vi.fn();
      const handler = new DiskFullHandler({ onDegraded, notify });

      handler.handleWriteError(new Error('EIO'));
      expect(handler.degraded).toBe(true);
      expect(onDegraded).toHaveBeenCalledTimes(1);
    });

    it('is idempotent: second call does not re-fire onDegraded or notify', () => {
      const onDegraded = vi.fn();
      const notify = vi.fn();
      const handler = new DiskFullHandler({ onDegraded, notify });

      const err = new Error('ENOSPC');
      handler.handleWriteError(err);
      handler.handleWriteError(err);
      handler.handleWriteError(err);

      expect(onDegraded).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledTimes(1);
    });
  });

  describe('enqueue — before degraded', () => {
    it('returns false for any entry before degraded', () => {
      const handler = new DiskFullHandler({ onDegraded: vi.fn(), notify: vi.fn() });
      const entry = makeEntry('session.end', 0);
      expect(handler.enqueue(entry)).toBe(false);
      expect(handler.snapshot()).toHaveLength(0);
    });
  });

  describe('enqueue — after degraded', () => {
    it('accepts critical entries and returns true', () => {
      const handler = new DiskFullHandler({ onDegraded: vi.fn(), notify: vi.fn() });
      handler.handleWriteError(new Error('ENOSPC'));

      // Verify we test all critical kinds.
      const criticalKinds = Array.from(CRITICAL_KINDS);
      expect(criticalKinds.length).toBeGreaterThan(0);

      let prevHash = GENESIS_PREV_HASH;
      let seq = 0;
      for (const kind of criticalKinds) {
        const entry = makeEntry(kind, seq++, prevHash);
        const accepted = handler.enqueue(entry);
        expect(accepted).toBe(true);
        prevHash = entry.hash;
      }

      expect(handler.snapshot()).toHaveLength(criticalKinds.length);
    });

    it('drops non-critical entries and returns false', () => {
      const handler = new DiskFullHandler({ onDegraded: vi.fn(), notify: vi.fn() });
      handler.handleWriteError(new Error('ENOSPC'));

      const nonCritical: EventKind[] = ['doc.change', 'doc.open', 'session.heartbeat', 'paste'];
      for (const kind of nonCritical) {
        const entry = makeEntry(kind, 0);
        expect(handler.enqueue(entry)).toBe(false);
      }

      expect(handler.snapshot()).toHaveLength(0);
    });

    it('ring is unchanged after a dropped non-critical entry', () => {
      const handler = new DiskFullHandler({ onDegraded: vi.fn(), notify: vi.fn() });
      handler.handleWriteError(new Error('ENOSPC'));

      // Add one critical entry.
      const critical = makeEntry('session.end', 0);
      handler.enqueue(critical);

      // Then a non-critical one.
      const nonCritical = makeEntry('doc.change', 1, critical.hash);
      handler.enqueue(nonCritical);

      // Ring still has only the critical one.
      expect(handler.snapshot()).toHaveLength(1);
      expect(handler.snapshot()[0]?.kind).toBe('session.end');
    });
  });

  describe('ring eviction', () => {
    it('drops oldest when capacity is exceeded', () => {
      const capacity = 3;
      const handler = new DiskFullHandler({
        onDegraded: vi.fn(),
        notify: vi.fn(),
        ringCapacity: capacity,
      });
      handler.handleWriteError(new Error('ENOSPC'));

      // Enqueue capacity+1 'session.end' entries.
      let prevHash = GENESIS_PREV_HASH;
      const entries: HashedEnvelope[] = [];
      for (let i = 0; i < capacity + 1; i++) {
        const e = makeEntry('session.end', i, prevHash);
        handler.enqueue(e);
        entries.push(e);
        prevHash = e.hash;
      }

      const snap = handler.snapshot();
      // Ring should have exactly `capacity` entries.
      expect(snap).toHaveLength(capacity);
      // The oldest (entries[0]) should be gone.
      expect(snap[0]?.seq).toBe(1);
      // The newest should be the last one we inserted.
      expect(snap[capacity - 1]?.seq).toBe(capacity);
    });

    it('uses default capacity of 256', () => {
      const handler = new DiskFullHandler({ onDegraded: vi.fn(), notify: vi.fn() });
      handler.handleWriteError(new Error('ENOSPC'));

      // Fill to 256 (exactly at capacity — should not evict).
      let prevHash = GENESIS_PREV_HASH;
      for (let i = 0; i < 256; i++) {
        const e = makeEntry('session.end', i, prevHash);
        handler.enqueue(e);
        prevHash = e.hash;
      }
      expect(handler.snapshot()).toHaveLength(256);

      // 257th entry should evict oldest.
      const last = makeEntry('session.end', 256, prevHash);
      handler.enqueue(last);
      expect(handler.snapshot()).toHaveLength(256);
      expect(handler.snapshot()[0]?.seq).toBe(1);
    });
  });

  describe('snapshot', () => {
    it('returns a copy — mutating the copy does not affect internal state', () => {
      const handler = new DiskFullHandler({ onDegraded: vi.fn(), notify: vi.fn() });
      handler.handleWriteError(new Error('ENOSPC'));

      const entry = makeEntry('session.end', 0);
      handler.enqueue(entry);

      const copy = handler.snapshot();
      expect(copy).toHaveLength(1);

      // Mutate the copy.
      copy.splice(0, 1);
      expect(copy).toHaveLength(0);

      // Internal ring should be unchanged.
      expect(handler.snapshot()).toHaveLength(1);
    });

    it('returns empty array when ring is empty', () => {
      const handler = new DiskFullHandler({ onDegraded: vi.fn(), notify: vi.fn() });
      expect(handler.snapshot()).toEqual([]);
    });
  });
});
