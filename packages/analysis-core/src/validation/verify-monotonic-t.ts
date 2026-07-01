/**
 * Check 5 — Monotonically non-decreasing t.
 * PRD §5.4 step 5.
 *
 * Walks each session's events directly. For every entry from index 1,
 * asserts entry.t >= prevEntry.t. Records every regression.
 */

import type { Bundle } from '../loader/types.js';
import type { ValidationCheck } from './check-types.js';

export function verifyMonotonicT(bundle: Bundle): ValidationCheck {
  const failures: Array<{ sessionId: string; seq: number }> = [];

  for (const session of bundle.sessions) {
    const events = session.events;
    for (let i = 1; i < events.length; i++) {
      const prev = events[i - 1];
      const entry = events[i];
      if (prev === undefined || entry === undefined) continue;

      if (entry.t < prev.t) {
        failures.push({ sessionId: session.sessionId, seq: entry.seq });
      }
    }
  }

  if (failures.length > 0) {
    return {
      id: 'monotonic_t',
      label: 'Monotonically non-decreasing t',
      status: 'fail',
      detail: `${failures.length} t regression(s) detected. The session-relative timestamp went backward.`,
      supportingSeqs: failures,
    };
  }

  return {
    id: 'monotonic_t',
    label: 'Monotonically non-decreasing t',
    status: 'pass',
  };
}
