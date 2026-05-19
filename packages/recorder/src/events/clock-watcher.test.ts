/**
 * Tests for startClockWatcher.
 *
 * Uses vi.useFakeTimers() to control interval ticks.
 * Injects stubbed getMonotonicMs / getWallMs to simulate drift without real time.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { startClockWatcher } from './clock-watcher.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a set of test deps with controllable clocks.
 *
 * monotonic and wall both start at 0.
 * Caller advances them independently to simulate drift.
 */
function makeTestDeps(overrides?: { intervalMs?: number; driftThresholdMs?: number }) {
  let monotonic = 0;
  let wall = 0;

  const emitted: Array<{ delta_ms: number }> = [];
  const emit = (data: { delta_ms: number }) => emitted.push(data);

  return {
    deps: {
      intervalMs: overrides?.intervalMs ?? 10,
      driftThresholdMs: overrides?.driftThresholdMs ?? 100,
      emit,
      getMonotonicMs: () => monotonic,
      getWallMs: () => wall,
    },
    advanceMonotonic: (ms: number) => {
      monotonic += ms;
    },
    advanceWall: (ms: number) => {
      wall += ms;
    },
    // Advance both in lock-step (no drift).
    advanceBoth: (ms: number) => {
      monotonic += ms;
      wall += ms;
    },
    emitted,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('startClockWatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('no drift over many ticks: no emit', () => {
    const t = makeTestDeps({ intervalMs: 10, driftThresholdMs: 100 });
    const disposable = startClockWatcher(t.deps);

    // Advance both clocks in lock-step across 5 ticks.
    for (let i = 0; i < 5; i++) {
      t.advanceBoth(10);
      vi.advanceTimersByTime(10);
    }

    expect(t.emitted).toHaveLength(0);
    disposable.dispose();
  });

  it('drift below threshold: no emit', () => {
    // Threshold: 100ms. We'll produce 50ms of drift — below threshold.
    const t = makeTestDeps({ intervalMs: 10, driftThresholdMs: 100 });
    const disposable = startClockWatcher(t.deps);

    // monotonic advances 10, wall advances 10 + 50 = 60 → drift = 50.
    t.advanceMonotonic(10);
    t.advanceWall(60);
    vi.advanceTimersByTime(10);

    expect(t.emitted).toHaveLength(0);
    disposable.dispose();
  });

  it('drift above threshold (positive): emits with correct delta_ms', () => {
    const t = makeTestDeps({ intervalMs: 10, driftThresholdMs: 100 });
    const disposable = startClockWatcher(t.deps);

    // monotonic: +10, wall: +200 → drift = 200 - 10 = 190 (positive, above threshold).
    t.advanceMonotonic(10);
    t.advanceWall(200);
    vi.advanceTimersByTime(10);

    expect(t.emitted).toHaveLength(1);
    expect(t.emitted[0]?.delta_ms).toBe(190);

    disposable.dispose();
  });

  it('drift above threshold (negative): emits with negative delta_ms', () => {
    const t = makeTestDeps({ intervalMs: 10, driftThresholdMs: 100 });
    const disposable = startClockWatcher(t.deps);

    // monotonic: +200, wall: +10 → drift = 10 - 200 = -190 (negative, above |threshold|).
    t.advanceMonotonic(200);
    t.advanceWall(10);
    vi.advanceTimersByTime(10);

    expect(t.emitted).toHaveLength(1);
    expect(t.emitted[0]?.delta_ms).toBe(-190);

    disposable.dispose();
  });

  it('drift above threshold on tick N, same drift does not re-emit on tick N+1', () => {
    const t = makeTestDeps({ intervalMs: 10, driftThresholdMs: 100 });
    const disposable = startClockWatcher(t.deps);

    // First tick: produce a large drift (emit + reset reference points).
    t.advanceMonotonic(10);
    t.advanceWall(200);
    vi.advanceTimersByTime(10);

    expect(t.emitted).toHaveLength(1);

    // Second tick: advance both by 10 from the new reference (no additional drift).
    t.advanceBoth(10);
    vi.advanceTimersByTime(10);

    // Still only 1 emit.
    expect(t.emitted).toHaveLength(1);

    disposable.dispose();
  });

  it('dispose() clears the interval: no further ticks fire', () => {
    const t = makeTestDeps({ intervalMs: 10, driftThresholdMs: 100 });
    const disposable = startClockWatcher(t.deps);

    disposable.dispose();

    // Produce large drift after dispose.
    t.advanceMonotonic(10);
    t.advanceWall(10000);
    vi.advanceTimersByTime(100);

    expect(t.emitted).toHaveLength(0);
  });
});
