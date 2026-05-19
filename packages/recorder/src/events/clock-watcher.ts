/**
 * Clock-skew watcher.
 *
 * PRD §4.2: "clock.skew — Wall clock jumps non-monotonically — delta_ms."
 * CLAUDE.md: "Use a monotonic clock for `t`. Use wall clock for `wall`. Don't conflate."
 *
 * Behavior:
 * - Record t0Monotonic and t0Wall at start.
 * - On each tick: compute expected elapsed (monotonic delta) and actual elapsed (wall delta).
 * - If |actual - expected| >= driftThresholdMs, emit { delta_ms: actual - expected } and
 *   reset the reference points so subsequent ticks don't keep re-emitting the same drift.
 * - Returns a Disposable that clears the interval. .unref() the timer.
 *
 * CLAUDE.md: "Every `setInterval`, every watcher, every async loop has a `dispose()`."
 */

import * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ClockWatcherDeps = {
  /** Interval between checks. Default: 1_000 ms. */
  intervalMs?: number;
  /** Minimum |drift| to emit. Default: 500 ms. */
  driftThresholdMs?: number;
  /** Called when drift exceeds the threshold. */
  emit: (data: { delta_ms: number }) => void;
  /** Returns the current monotonic time in ms (e.g. performance.now()). */
  getMonotonicMs: () => number;
  /** Returns the current wall-clock time in ms (e.g. Date.now()). */
  getWallMs: () => number;
};

// ---------------------------------------------------------------------------
// startClockWatcher
// ---------------------------------------------------------------------------

/**
 * Start the clock-skew watcher.
 * Returns a Disposable that clears the interval.
 */
export function startClockWatcher(deps: ClockWatcherDeps): vscode.Disposable {
  const { intervalMs = 1_000, driftThresholdMs = 500, emit, getMonotonicMs, getWallMs } = deps;

  // Capture reference points at start.
  let t0Monotonic = getMonotonicMs();
  let t0Wall = getWallMs();

  const timer = setInterval(() => {
    const now = getMonotonicMs();
    const nowWall = getWallMs();

    const expected = now - t0Monotonic; // how much monotonic time elapsed
    const actual = nowWall - t0Wall; // how much wall time elapsed
    const drift = actual - expected;

    if (Math.abs(drift) >= driftThresholdMs) {
      emit({ delta_ms: drift });
      // Reset so we don't keep emitting on the same drift.
      t0Monotonic = now;
      t0Wall = nowWall;
    }
  }, intervalMs);

  // .unref() so the timer doesn't keep the process alive.
  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  return {
    dispose(): void {
      clearInterval(timer);
    },
  };
}
