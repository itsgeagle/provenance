/**
 * Clock abstraction for testable, deterministic time handling.
 * CLAUDE.md: "Tests must be deterministic. No Date.now() in assertions; inject a clock."
 * CLAUDE.md: "Use a monotonic clock for `t`. Use wall clock for `wall`. Don't conflate."
 */

export interface Clock {
  /** Returns a monotonic millisecond timestamp with no defined epoch (suitable for `t`). */
  now(): number;
  /** Returns the current wall time as an ISO 8601 UTC string (suitable for `wall`). */
  wall(): string;
}

/**
 * Production clock implementation.
 *
 * now() uses performance.now() for monotonicity — available as a global in
 * Node ≥ 16 and all modern browsers without any import. Falls back to
 * Date.now() as a last resort for environments where performance is unavailable.
 *
 * wall() returns new Date().toISOString().
 */
export class SystemClock implements Clock {
  now(): number {
    // performance is a global in modern Node (≥16) and browsers; no import needed.
    // Guard for environments where it may be absent (e.g. very old runtimes).
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return performance.now();
    }
    return Date.now();
  }

  wall(): string {
    return new Date().toISOString();
  }
}

/**
 * Deterministic clock for tests.
 * Starts at a fixed monotonic value and wall time; advance(ms) moves both forward.
 */
export class FixedClock implements Clock {
  private _now: number;
  private _wall: Date;

  constructor(initialNow: number = 0, initialWall: Date = new Date(0)) {
    this._now = initialNow;
    this._wall = new Date(initialWall.getTime());
  }

  now(): number {
    return this._now;
  }

  wall(): string {
    return this._wall.toISOString();
  }

  /** Advance both the monotonic clock and the wall clock by `ms` milliseconds. */
  advance(ms: number): void {
    this._now += ms;
    this._wall = new Date(this._wall.getTime() + ms);
  }

  /** Directly set the monotonic value (for simulating non-wall jumps). */
  setNow(value: number): void {
    this._now = value;
  }

  /** Directly set the wall time. */
  setWall(value: Date): void {
    this._wall = new Date(value.getTime());
  }
}
