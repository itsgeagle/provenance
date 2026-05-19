/**
 * Check 6 — Monotonically non-decreasing wall clock (clock.skew-aware).
 * PRD §5.4 step 6.
 *
 * Calls log-core's validateChain per session and surfaces wall_regression
 * failures. The clock.skew window interpretation is already baked into
 * validateChain (see chain-validator.ts); we do not re-implement it.
 */

import { validateChain } from '@provenance/log-core';
import type { Bundle } from '../loader/types.js';
import type { ValidationCheck } from './check-types.js';

export function verifyMonotonicWall(bundle: Bundle): ValidationCheck {
  const failures: Array<{ sessionId: string; seq: number }> = [];

  for (const session of bundle.sessions) {
    let events = session.events;
    while (true) {
      const result = validateChain(events);
      if (result.ok) break;
      if (result.break.reason !== 'wall_regression') break; // handled by other checks
      failures.push({ sessionId: session.sessionId, seq: result.break.at_seq });
      // Advance past the bad entry.
      const breakIdx = events.findIndex((e) => e.seq === result.break.at_seq);
      if (breakIdx === -1 || breakIdx + 1 >= events.length) break;
      events = events.slice(breakIdx + 1);
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
