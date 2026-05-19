/**
 * Check 3 — Hash chain integrity.
 * PRD §5.4 step 3.
 *
 * Calls log-core's validateChain per session and surfaces hash_mismatch
 * failures. seq_gap, t_regression, and wall_regression are surfaced by their
 * own dedicated check files (checks 4–6).
 */

import { validateChain } from '@provenance/log-core';
import type { Bundle } from '../loader/types.js';
import type { ValidationCheck } from './check-types.js';

export function verifyChain(bundle: Bundle): ValidationCheck {
  const failures: Array<{ sessionId: string; seq: number }> = [];

  for (const session of bundle.sessions) {
    // validateChain stops at the first failure. Collect all failures by
    // re-running on the tail after each discovered break.
    let events = session.events;
    while (true) {
      const result = validateChain(events);
      if (result.ok) break;
      if (result.break.reason !== 'hash_mismatch') break; // handled by other checks
      failures.push({ sessionId: session.sessionId, seq: result.break.at_seq });
      // Advance past the broken entry to find additional breaks.
      const breakIdx = events.findIndex((e) => e.seq === result.break.at_seq);
      if (breakIdx === -1 || breakIdx + 1 >= events.length) break;
      events = events.slice(breakIdx + 1);
    }
  }

  if (failures.length > 0) {
    return {
      id: 'chain_integrity',
      label: 'Hash chain integrity',
      status: 'fail',
      detail: `${failures.length} hash mismatch(es) detected. The log may have been tampered with.`,
      supportingSeqs: failures,
    };
  }

  return {
    id: 'chain_integrity',
    label: 'Hash chain integrity',
    status: 'pass',
  };
}
