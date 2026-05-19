/**
 * Tests for Check 6 — Monotonically non-decreasing wall clock.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { loadBundle } from '../loader/parse-bundle.js';
import { buildTestBundle } from '../../test/helpers/build-test-bundle.js';
import { verifyMonotonicWall } from './verify-monotonic-wall.js';

beforeAll(() => {
  ed.hashes.sha512 = sha512;
  (ed.hashes as Record<string, unknown>)['sha512Async'] = (m: Uint8Array) =>
    Promise.resolve(sha512(m));
});

describe('verifyMonotonicWall', () => {
  it('returns pass for a valid bundle', async () => {
    const { blob } = await buildTestBundle({ sessions: [{ eventCount: 5 }] });
    const result = await loadBundle(blob, 'test.zip');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const check = verifyMonotonicWall(result.value);
    expect(check.id).toBe('monotonic_wall');
    expect(check.status).toBe('pass');
  });

  it('returns fail when a wall timestamp regresses without a clock.skew event', async () => {
    // Use the wallAt helper baseline: session 0, events at 2026-01-01 + i*10s.
    // We inject an earlier wall for entry 3 (seq 3) to make it regress.
    // With the direct-walk implementation, verify-monotonic-wall finds wall
    // regressions independently of hash state.
    const { blob } = await buildTestBundle({
      sessions: [{ eventCount: 5 }],
      tamper: {
        regressWall: {
          sessionIndex: 0,
          entryIndex: 3,
          earlierWall: '2026-01-01T00:00:00.000Z', // before entry 2's wall
        },
      },
    });
    const result = await loadBundle(blob, 'test.zip');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const check = verifyMonotonicWall(result.value);
    expect(check.id).toBe('monotonic_wall');
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(/wall-clock regression/i);
    expect(check.supportingSeqs).toBeDefined();
    expect(check.supportingSeqs![0]?.seq).toBe(3);
  });

  it('returns pass for a bundle where all walls are monotonically increasing', async () => {
    const walls = [
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:10.000Z',
      '2026-01-01T00:00:20.000Z',
      '2026-01-01T00:00:30.000Z',
    ];
    const { blob } = await buildTestBundle({
      sessions: [{ eventCount: 3, walls }],
    });
    const result = await loadBundle(blob, 'test.zip');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const check = verifyMonotonicWall(result.value);
    expect(check.status).toBe('pass');
  });

  it('collects all wall regressions in a session, not just the first', async () => {
    // Regress wall at entry index 2 and entry index 4.
    // Base walls for session 0: 2026-01-01T00:00:00Z + i*10s.
    // Entry 2 wall = 2026-01-01T00:00:20Z; entry 4 wall = 2026-01-01T00:00:40Z.
    const { blob } = await buildTestBundle({
      sessions: [{ eventCount: 5 }],
      tamper: {
        regressWall: [
          { sessionIndex: 0, entryIndex: 2, earlierWall: '2026-01-01T00:00:00.000Z' },
          { sessionIndex: 0, entryIndex: 4, earlierWall: '2026-01-01T00:00:00.000Z' },
        ],
      },
    });
    const result = await loadBundle(blob, 'test.zip');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const check = verifyMonotonicWall(result.value);
    expect(check.status).toBe('fail');
    expect(check.supportingSeqs).toBeDefined();
    // Both regressions must appear.
    const seqs = check.supportingSeqs!.map((s) => s.seq);
    expect(seqs).toContain(2);
    expect(seqs).toContain(4);
  });
});
