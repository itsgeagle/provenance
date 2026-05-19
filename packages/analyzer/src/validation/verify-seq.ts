/**
 * Check 4 — No seq gaps.
 * PRD §5.4 step 4.
 *
 * Walks each session's events directly. Each entry's seq must equal its
 * 0-based array index (i.e. seq 0, 1, 2, …). Any deviation is a gap.
 *
 * Reports one failure per contiguous run of misaligned entries — if seq
 * jumps from 5 to 10 that is ONE gap (not 4), recorded at the first
 * out-of-order entry. After a gap the expected counter advances past the
 * gap so subsequent entries are evaluated relative to their own position,
 * not the gap point.
 */

import type { Bundle } from '../loader/types.js';
import type { ValidationCheck } from './check-types.js';

export function verifySeq(bundle: Bundle): ValidationCheck {
  const failures: Array<{ sessionId: string; seq: number; expected: number }> = [];

  for (const session of bundle.sessions) {
    let inGap = false;

    for (let i = 0; i < session.events.length; i++) {
      const entry = session.events[i];
      if (entry === undefined) continue;

      if (entry.seq !== i) {
        if (!inGap) {
          // Record the first entry of each contiguous misalignment run.
          failures.push({
            sessionId: session.sessionId,
            seq: entry.seq,
            expected: i,
          });
          inGap = true;
        }
        // Continue walking — the array index i still increments correctly,
        // so subsequent entries will be compared to their own correct position.
      } else {
        inGap = false;
      }
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
