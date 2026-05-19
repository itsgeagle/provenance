/**
 * integrity-flags adapter (Phase 4).
 *
 * Converts failing ValidationReport checks into Flag objects. In v1, only
 * check 3 (`chain_integrity`) is handled. v2 will extend this adapter to
 * surface checks 1, 2, 5, 6 as flags (manifest_sig, session_binding,
 * monotonic_t, monotonic_wall) per the plan's Phase 17 scope.
 *
 * This is an adapter, not a heuristic in the traditional sense — it does not
 * re-analyze the event stream. It converts the validation pipeline's output
 * into the same Flag shape so the dashboard can display them uniformly.
 *
 * The `runHeuristics` orchestrator calls this separately (it takes a
 * ValidationReport argument) and merges the result into the overall flag list.
 */

import type { ValidationReport } from '../validation/check-types.js';
import type { Flag } from './types.js';

// ---------------------------------------------------------------------------
// v1 adapter: chain_integrity → Flag
// ---------------------------------------------------------------------------

/**
 * Convert a failing chain_integrity check into a Flag.
 *
 * The check's `supportingSeqs` field contains `{ sessionId, seq }` pairs
 * that identify the exact entries where the chain break was detected.
 * We convert them to `${sessionId}:${seq}` strings (EventIndex.bySeq key
 * format) for UI deep-linking.
 *
 * Flag properties:
 *   - heuristic: 'chain_broken'
 *   - severity: 'high' (always — cryptographic failure)
 *   - confidence: 1.0 (deterministic check, no ambiguity)
 *   - supportingSeqs: from check.supportingSeqs
 *   - description: from check.detail
 */
export function integrityFlagsFromReport(report: ValidationReport): Flag[] {
  const flags: Flag[] = [];

  for (const check of report.checks) {
    if (check.id === 'chain_integrity' && check.status === 'fail') {
      const rawSeqs = check.supportingSeqs ?? [];
      const supportingSeqs = rawSeqs.map((s) => `${s.sessionId}:${s.seq}`);

      // Deterministic flag id: derived from the first supporting seq (or the
      // check id alone if no seqs are available).
      const seqKey0 = supportingSeqs[0] ?? 'no-seq';
      const id = `chain_broken-${seqKey0}`;

      flags.push({
        id,
        heuristic: 'chain_broken',
        title: 'Hash chain integrity failure',
        severity: 'high',
        confidence: 1.0,
        supportingSeqs,
        description:
          check.detail ??
          'The hash chain failed validation. One or more log entries have been tampered with.',
        detail: {
          checkId: check.id,
          checkLabel: check.label,
          entryCount: rawSeqs.length,
        },
      });
    }
  }

  return flags;
}
