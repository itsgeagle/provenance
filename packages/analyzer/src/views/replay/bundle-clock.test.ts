/**
 * Tests for bundle-clock — the whole-bundle playback timeline.
 *
 * The invariant that matters most: bundleT must be non-decreasing no matter
 * what the input wall clocks say. Recorder sessions can come from different
 * machines with skewed clocks (see the clock_jumps heuristic), and a rewinding
 * playback clock would break the replay engine's tick loop.
 */

import { describe, it, expect } from 'vitest';
import { buildBundleClock, formatGap, SEAM_FLOOR_MS, SEAM_MAX_GAP_MS } from './bundle-clock.js';
import type { IndexedEvent } from '@provenance/analysis-core/index/event-index.js';

function ev(globalIdx: number, sessionId: string, t: number, wall: string): IndexedEvent {
  return { globalIdx, sessionId, seq: globalIdx, t, wall, kind: 'doc.change', payload: null };
}

describe('buildBundleClock', () => {
  it('returns an empty clock for no events', () => {
    const clock = buildBundleClock([]);
    expect(clock.bundleT.length).toBe(0);
    expect(clock.seams).toEqual([]);
  });

  it('returns a single zero for one event', () => {
    const clock = buildBundleClock([ev(0, 'a', 0, '2026-01-01T00:00:00.000Z')]);
    expect(Array.from(clock.bundleT)).toEqual([0]);
    expect(clock.seams).toEqual([]);
  });

  it('accumulates t deltas within a single session and reports no seams', () => {
    const clock = buildBundleClock([
      ev(0, 'a', 0, '2026-01-01T00:00:00.000Z'),
      ev(1, 'a', 100, '2026-01-01T00:00:00.100Z'),
      ev(2, 'a', 450, '2026-01-01T00:00:00.450Z'),
    ]);
    expect(Array.from(clock.bundleT)).toEqual([0, 100, 450]);
    expect(clock.seams).toEqual([]);
  });

  it('collapses a long inter-session gap to SEAM_MAX_GAP_MS', () => {
    const clock = buildBundleClock([
      ev(0, 'a', 0, '2026-01-01T00:00:00.000Z'),
      ev(1, 'a', 100, '2026-01-01T00:00:00.100Z'),
      // Next session starts four hours later, and its `t` resets to 0.
      ev(2, 'b', 0, '2026-01-01T04:00:00.100Z'),
      ev(3, 'b', 50, '2026-01-01T04:00:00.150Z'),
    ]);
    expect(Array.from(clock.bundleT)).toEqual([
      0,
      100,
      100 + SEAM_MAX_GAP_MS,
      100 + SEAM_MAX_GAP_MS + 50,
    ]);
    expect(clock.seams).toHaveLength(1);
    expect(clock.seams[0]).toMatchObject({
      atGlobalIdx: 2,
      prevSessionId: 'a',
      nextSessionId: 'b',
      realGapMs: 4 * 60 * 60 * 1000,
      collapsedGapMs: SEAM_MAX_GAP_MS,
    });
  });

  it('raises a sub-floor gap to SEAM_FLOOR_MS', () => {
    const clock = buildBundleClock([
      ev(0, 'a', 0, '2026-01-01T00:00:00.000Z'),
      ev(1, 'b', 0, '2026-01-01T00:00:00.200Z'),
    ]);
    expect(clock.seams[0]!.realGapMs).toBe(200);
    expect(clock.seams[0]!.collapsedGapMs).toBe(SEAM_FLOOR_MS);
    expect(Array.from(clock.bundleT)).toEqual([0, SEAM_FLOOR_MS]);
  });

  it('clamps a negative gap (clock skew) to SEAM_FLOOR_MS and stays monotonic', () => {
    const clock = buildBundleClock([
      ev(0, 'a', 0, '2026-01-01T05:00:00.000Z'),
      // The next session's wall clock is EARLIER than the previous session's.
      ev(1, 'b', 0, '2026-01-01T04:00:00.000Z'),
    ]);
    expect(clock.seams[0]!.realGapMs).toBeLessThan(0);
    expect(clock.seams[0]!.collapsedGapMs).toBe(SEAM_FLOOR_MS);
    expect(Array.from(clock.bundleT)).toEqual([0, SEAM_FLOOR_MS]);
  });

  it('clamps an unparseable wall to SEAM_FLOOR_MS', () => {
    const clock = buildBundleClock([ev(0, 'a', 0, 'not-a-date'), ev(1, 'b', 0, 'also-not-a-date')]);
    expect(clock.seams[0]!.collapsedGapMs).toBe(SEAM_FLOOR_MS);
    expect(Array.from(clock.bundleT)).toEqual([0, SEAM_FLOOR_MS]);
  });

  it('never decreases when t goes backwards within a session', () => {
    const clock = buildBundleClock([
      ev(0, 'a', 0, '2026-01-01T00:00:00.000Z'),
      ev(1, 'a', 500, '2026-01-01T00:00:00.500Z'),
      ev(2, 'a', 200, '2026-01-01T00:00:00.700Z'), // t regressed
    ]);
    const arr = Array.from(clock.bundleT);
    expect(arr).toEqual([0, 500, 500]);
    for (let i = 1; i < arr.length; i++) {
      expect(arr[i]!).toBeGreaterThanOrEqual(arr[i - 1]!);
    }
  });

  it('honors a maxSeamGapMs override', () => {
    const clock = buildBundleClock(
      [ev(0, 'a', 0, '2026-01-01T00:00:00.000Z'), ev(1, 'b', 0, '2026-01-01T10:00:00.000Z')],
      { maxSeamGapMs: 2_000 },
    );
    expect(clock.seams[0]!.collapsedGapMs).toBe(2_000);
  });

  it('records one seam per session transition across three sessions', () => {
    const clock = buildBundleClock([
      ev(0, 'a', 0, '2026-01-01T00:00:00.000Z'),
      ev(1, 'b', 0, '2026-01-01T01:00:00.000Z'),
      ev(2, 'c', 0, '2026-01-01T02:00:00.000Z'),
    ]);
    expect(clock.seams.map((s) => s.atGlobalIdx)).toEqual([1, 2]);
    expect(clock.seams.map((s) => s.nextSessionId)).toEqual(['b', 'c']);
  });

  it('treats a returning session id as a new seam', () => {
    // Interleaved/concurrent sessions can produce a-b-a in wall order.
    const clock = buildBundleClock([
      ev(0, 'a', 0, '2026-01-01T00:00:00.000Z'),
      ev(1, 'b', 0, '2026-01-01T00:10:00.000Z'),
      ev(2, 'a', 600_000, '2026-01-01T00:20:00.000Z'),
    ]);
    expect(clock.seams).toHaveLength(2);
    expect(clock.seams.map((s) => s.nextSessionId)).toEqual(['b', 'a']);
  });
});

describe('formatGap', () => {
  it('formats sub-minute gaps in seconds', () => {
    expect(formatGap(5_000)).toBe('5s');
  });

  it('formats minute-scale gaps', () => {
    expect(formatGap(65_000)).toBe('1m 5s');
  });

  it('formats hour-scale gaps without seconds', () => {
    expect(formatGap(15_120_000)).toBe('4h 12m');
  });

  it('formats day-scale gaps', () => {
    expect(formatGap(2 * 24 * 60 * 60 * 1000 + 3 * 60 * 60 * 1000)).toBe('2d 3h');
  });

  it('reports unknown for a negative or non-finite gap', () => {
    expect(formatGap(-1)).toBe('unknown');
    expect(formatGap(NaN)).toBe('unknown');
  });
});
