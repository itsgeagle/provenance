/**
 * Check 6 — Monotonically non-decreasing wall clock (clock.skew-aware).
 * PRD §5.4 step 6.
 *
 * Walks each session's events directly. For every entry from index 1,
 * asserts entry.wall >= prevEntry.wall unless a clock.skew event appears in
 * the inclusive window [prev.seq, entry.seq]. Records every unexcused
 * regression.
 *
 * The clock.skew set is precomputed once per session for O(N) overall cost.
 */

import type { Bundle } from '../loader/types.js';
import type { ValidationCheck } from './check-types.js';

export function verifyMonotonicWall(bundle: Bundle): ValidationCheck {
  const failures: Array<{ sessionId: string; seq: number }> = [];

  for (const session of bundle.sessions) {
    const events = session.events;

    // Precompute the set of seq values where clock.skew events occur.
    const clockSkewSeqs = new Set<number>();
    for (const entry of events) {
      if (entry.kind === 'clock.skew') {
        clockSkewSeqs.add(entry.seq);
      }
    }

    for (let i = 1; i < events.length; i++) {
      const prev = events[i - 1];
      const entry = events[i];
      if (prev === undefined || entry === undefined) continue;

      if (entry.wall < prev.wall) {
        // Check if any clock.skew event falls in the inclusive window [prev.seq, entry.seq].
        let excused = false;
        for (let s = prev.seq; s <= entry.seq; s++) {
          if (clockSkewSeqs.has(s)) {
            excused = true;
            break;
          }
        }
        if (!excused) {
          failures.push({ sessionId: session.sessionId, seq: entry.seq });
        }
      }
    }
  }

  if (failures.length > 0) {
    return {
      id: 'monotonic_wall',
      label: 'Monotonically non-decreasing wall clock',
      status: 'fail',
      detail:
        `${failures.length} wall-clock regression(s) detected (not excused by a clock.skew event). ` +
        `This may indicate log manipulation or a system clock issue.`,
      supportingSeqs: failures,
    };
  }

  return {
    id: 'monotonic_wall',
    label: 'Monotonically non-decreasing wall clock',
    status: 'pass',
  };
}
