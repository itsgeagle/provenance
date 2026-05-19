/**
 * Check 4 — No seq gaps.
 * PRD §5.4 step 4.
 *
 * Calls log-core's validateChain per session and surfaces seq_gap failures.
 */

import { validateChain } from '@provenance/log-core';
import type { Bundle } from '../loader/types.js';
import type { ValidationCheck } from './check-types.js';

export function verifySeq(bundle: Bundle): ValidationCheck {
  const failures: Array<{ sessionId: string; seq: number; expected: number }> = [];

  for (const session of bundle.sessions) {
    let events = session.events;
    while (true) {
      const result = validateChain(events);
      if (result.ok) break;
      if (result.break.reason !== 'seq_gap') break; // handled by other checks
      failures.push({
        sessionId: session.sessionId,
        seq: result.break.at_seq,
        expected: result.break.expected,
      });
      // Advance past the gap to find additional gaps.
      const breakIdx = events.findIndex((e) => e.seq === result.break.at_seq);
      if (breakIdx === -1 || breakIdx + 1 >= events.length) break;
      events = events.slice(breakIdx + 1);
    }
  }

  if (failures.length > 0) {
    const descriptions = failures.map(
      (f) => `session ${f.sessionId}: expected seq ${f.expected}, got ${f.seq}`,
    );
    return {
      id: 'seq_gaps',
      label: 'No seq gaps',
      status: 'fail',
      detail: `${failures.length} seq gap(s) detected: ${descriptions.join('; ')}.`,
      supportingSeqs: failures.map((f) => ({ sessionId: f.sessionId, seq: f.seq })),
    };
  }

  return {
    id: 'seq_gaps',
    label: 'No seq gaps',
    status: 'pass',
  };
}
