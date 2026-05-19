import { describe, it, expect } from 'vitest';
import { validateChain } from './chain-validator.js';
import { chainEntry, GENESIS_PREV_HASH } from './hash-chain.js';
import type { Envelope, HashedEnvelope } from './envelope.js';
import type { EventKind } from './events.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a valid chain of `count` entries, starting from GENESIS_PREV_HASH.
 * Uses 'session.heartbeat' for all entries (kind doesn't matter for chain tests).
 */
function buildChain(count: number): HashedEnvelope[] {
  const entries: HashedEnvelope[] = [];
  let prevHash = GENESIS_PREV_HASH;
  for (let i = 0; i < count; i++) {
    const envelope: Envelope<'session.heartbeat'> = {
      seq: i,
      t: i * 100,
      wall: `2026-01-01T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`,
      kind: 'session.heartbeat',
      data: { focused: true, active_file: 'hw.py', idle_since_ms: 0 },
    };
    const hashed = chainEntry(prevHash, envelope);
    entries.push(hashed);
    prevHash = hashed.hash;
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('validateChain', () => {
  it('returns ok for an empty array', () => {
    expect(validateChain([])).toEqual({ ok: true });
  });

  it('returns ok for a single valid genesis entry', () => {
    const entries = buildChain(1);
    expect(validateChain(entries)).toEqual({ ok: true });
  });

  it('returns ok for a 5-entry valid chain', () => {
    const entries = buildChain(5);
    expect(validateChain(entries)).toEqual({ ok: true });
  });

  it('detects hash_mismatch when an entry data is mutated', () => {
    const entries = buildChain(5);
    // Mutate entry at index 3 (seq 3)
    const mutated = [...entries] as HashedEnvelope[];
    const original = mutated[3]!;
    mutated[3] = {
      ...original,
      data: { focused: false, active_file: null, idle_since_ms: 99999 },
    } as HashedEnvelope<'session.heartbeat'>;

    const result = validateChain(mutated);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.break.reason).toBe('hash_mismatch');
      expect(result.break.at_seq).toBe(3);
    }
  });

  it('detects hash_mismatch when the prev_hash link is broken', () => {
    const entries = buildChain(5);
    // Break the link at seq 2 by corrupting its prev_hash.
    const mutated = [...entries] as HashedEnvelope[];
    mutated[2] = { ...mutated[2]!, prev_hash: 'a'.repeat(64) };

    const result = validateChain(mutated);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.break.reason).toBe('hash_mismatch');
      expect(result.break.at_seq).toBe(2);
    }
  });

  it('detects seq_gap when a seq number is wrong', () => {
    const entries = buildChain(5);
    // Simulate a missing entry by setting seq 3 to have seq 4.
    const mutated = [...entries] as HashedEnvelope[];
    mutated[3] = { ...mutated[3]!, seq: 4 };

    const result = validateChain(mutated);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.break.reason).toBe('seq_gap');
      // at_seq is the found seq (4), expected is 3.
      expect(
        (result.break as { reason: 'seq_gap'; at_seq: number; expected: number }).expected,
      ).toBe(3);
    }
  });

  it('detects t_regression when t decreases', () => {
    const entries = buildChain(5);
    // Make entry 3 have a t smaller than entry 2's t.
    const mutated = [...entries] as HashedEnvelope[];
    const prev = mutated[2]!;
    // Rebuild entry 3 with a lower t but recompute the hash so prev_hash linkage is valid.
    const envelope: Envelope<'session.heartbeat'> = {
      seq: 3,
      t: prev.t - 1, // regression
      wall: '2026-01-01T00:00:03.000Z',
      kind: 'session.heartbeat',
      data: { focused: true, active_file: null, idle_since_ms: 0 },
    };
    const relinked = chainEntry(prev.hash, envelope);
    // Recompute the rest of the chain from seq 4 onwards.
    const rebuiltChain: HashedEnvelope[] = [...mutated.slice(0, 3), relinked];
    let prevHash = relinked.hash;
    for (let i = 4; i < entries.length; i++) {
      const orig = entries[i]!;
      const env: Envelope<EventKind> = {
        seq: orig.seq,
        t: orig.t,
        wall: orig.wall,
        kind: orig.kind,
        data: orig.data,
      };
      const h = chainEntry(prevHash, env);
      rebuiltChain.push(h);
      prevHash = h.hash;
    }

    const result = validateChain(rebuiltChain);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.break.reason).toBe('t_regression');
      expect(result.break.at_seq).toBe(3);
    }
  });

  it('detects wall_regression when wall goes backwards with no clock.skew', () => {
    const entries = buildChain(5);
    // Rebuild entry 3 with an earlier wall time.
    const prev = entries[2]!;
    const envelope: Envelope<'session.heartbeat'> = {
      seq: 3,
      t: prev.t + 100, // t is fine
      wall: '2026-01-01T00:00:00.001Z', // earlier than entry 2's wall
      kind: 'session.heartbeat',
      data: { focused: true, active_file: null, idle_since_ms: 0 },
    };
    const relinked = chainEntry(prev.hash, envelope);
    const rebuiltChain: HashedEnvelope[] = [
      ...entries.slice(0, 3),
      relinked,
      ...rebuildTail(entries, relinked, 4),
    ];

    const result = validateChain(rebuiltChain);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.break.reason).toBe('wall_regression');
      expect(result.break.at_seq).toBe(3);
    }
  });

  it('allows wall_regression when a clock.skew event is present between the two entries', () => {
    // Build: seq 0 (heartbeat), seq 1 (clock.skew), seq 2 (heartbeat with earlier wall)
    const e0Env: Envelope<'session.heartbeat'> = {
      seq: 0,
      t: 0,
      wall: '2026-01-01T00:01:00.000Z',
      kind: 'session.heartbeat',
      data: { focused: true, active_file: null, idle_since_ms: 0 },
    };
    const e0 = chainEntry(GENESIS_PREV_HASH, e0Env);

    const e1Env: Envelope<'clock.skew'> = {
      seq: 1,
      t: 100,
      wall: '2026-01-01T00:01:01.000Z',
      kind: 'clock.skew',
      data: { delta_ms: -5000 },
    };
    const e1 = chainEntry(e0.hash, e1Env);

    // wall regresses: e2.wall < e0.wall
    const e2Env: Envelope<'session.heartbeat'> = {
      seq: 2,
      t: 200,
      wall: '2026-01-01T00:00:00.000Z', // earlier than e0.wall
      kind: 'session.heartbeat',
      data: { focused: true, active_file: null, idle_since_ms: 0 },
    };
    const e2 = chainEntry(e1.hash, e2Env);

    const result = validateChain([e0, e1, e2]);
    // The clock.skew at seq 1 (between seq 0 and seq 2) excuses the regression.
    expect(result).toEqual({ ok: true });
  });

  it('does not allow wall_regression at seq N if clock.skew is after N', () => {
    // seq 0 wall="T+1min", seq 1 wall regresses, seq 2 clock.skew (too late)
    const e0Env: Envelope<'session.heartbeat'> = {
      seq: 0,
      t: 0,
      wall: '2026-01-01T00:01:00.000Z',
      kind: 'session.heartbeat',
      data: { focused: true, active_file: null, idle_since_ms: 0 },
    };
    const e0 = chainEntry(GENESIS_PREV_HASH, e0Env);

    // Regression here — no clock.skew between seq 0 and seq 1
    const e1Env: Envelope<'session.heartbeat'> = {
      seq: 1,
      t: 100,
      wall: '2026-01-01T00:00:00.000Z',
      kind: 'session.heartbeat',
      data: { focused: true, active_file: null, idle_since_ms: 0 },
    };
    const e1 = chainEntry(e0.hash, e1Env);

    const result = validateChain([e0, e1]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.break.reason).toBe('wall_regression');
    }
  });
});

// ---------------------------------------------------------------------------
// Helper: rebuild tail of a chain after a replaced entry
// ---------------------------------------------------------------------------

function rebuildTail(
  original: HashedEnvelope[],
  newPrev: HashedEnvelope,
  fromSeq: number,
): HashedEnvelope[] {
  const tail: HashedEnvelope[] = [];
  let prevHash = newPrev.hash;
  for (let i = fromSeq; i < original.length; i++) {
    const orig = original[i]!;
    const env: Envelope<EventKind> = {
      seq: orig.seq,
      t: orig.t,
      wall: orig.wall,
      kind: orig.kind,
      data: orig.data,
    };
    const h = chainEntry(prevHash, env);
    tail.push(h);
    prevHash = h.hash;
  }
  return tail;
}
