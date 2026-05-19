/**
 * Check 5 — Monotonically non-decreasing t.
 * PRD §5.4 step 5.
 *
 * Calls log-core's validateChain per session and surfaces t_regression
 * failures.
 */

import { validateChain } from '@provenance/log-core';
import type { Bundle } from '../loader/types.js';
import type { ValidationCheck } from './check-types.js';

export function verifyMonotonicT(bundle: Bundle): ValidationCheck {
  const failures: Array<{ sessionId: string; seq: number }> = [];

  for (const session of bundle.sessions) {
    let events = session.events;
    while (true) {
      const result = validateChain(events);
      if (result.ok) break;
      if (result.break.reason !== 't_regression') break; // handled by other checks
      failures.push({ sessionId: session.sessionId, seq: result.break.at_seq });
      // Advance past the bad entry.
      const breakIdx = events.findIndex((e) => e.seq === result.break.at_seq);
      if (breakIdx === -1 || breakIdx + 1 >= events.length) break;
      events = events.slice(breakIdx + 1);
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
