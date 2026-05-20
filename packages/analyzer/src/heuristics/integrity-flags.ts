/**
 * integrity-flags adapter (Phase 4 + Phase 17).
 *
 * Converts failing ValidationReport checks into Flag objects.
 *
 * Checks surfaced:
 *   - check 1 (manifest_sig): signature verification failure → 'high'
 *   - check 2 (session_binding): session-to-manifest linkage failure → 'high'
 *   - check 3 (chain_integrity): hash chain break → 'high' (v1)
 *   - check 5 (monotonic_t): t-regression in events → 'medium'
 *   - check 6 (monotonic_wall): wall-time regression → 'medium'
 *
 * Checks NOT surfaced here:
 *   - check 4 (seq_gaps): surfaced if needed; not in PRD §7.4 flag list.
 *   - check 7 (doc_save_hashes): surfaced separately.
 *   - check 8 (submitted_code_match): always skipped in v1.
 *
 * This is an adapter, not a heuristic in the traditional sense — it does not
 * re-analyze the event stream. It converts the validation pipeline's output
 * into the same Flag shape so the dashboard can display them uniformly.
 *
 * The `runHeuristics` orchestrator calls this separately (it takes a
 * ValidationReport argument) and merges the result into the overall flag list.
 */

import type { ValidationCheckId, ValidationReport } from '../validation/check-types.js';
import type { Flag } from './types.js';
import type { Severity } from './types.js';

// ---------------------------------------------------------------------------
// Check metadata table
// ---------------------------------------------------------------------------

type CheckMeta = {
  heuristic: string;
  title: string;
  severity: Severity;
  confidence: number;
  fallbackDescription: string;
};

const CHECK_META: Partial<Record<ValidationCheckId, CheckMeta>> = {
  manifest_sig: {
    heuristic: 'manifest_sig_invalid',
    title: 'Manifest signature verification failed',
    severity: 'high',
    confidence: 1.0,
    fallbackDescription:
      'The bundle manifest signature failed ed25519 verification. The manifest may have been tampered with after sealing.',
  },
  session_binding: {
    heuristic: 'session_binding_invalid',
    title: 'Session binding verification failed',
    severity: 'high',
    confidence: 1.0,
    fallbackDescription:
      'One or more sessions failed the manifest-to-session binding check. The bundle may mix sessions from different recorder builds.',
  },
  chain_integrity: {
    heuristic: 'chain_broken',
    title: 'Hash chain integrity failure',
    severity: 'high',
    confidence: 1.0,
    fallbackDescription:
      'The hash chain failed validation. One or more log entries have been tampered with.',
  },
  monotonic_t: {
    heuristic: 'monotonic_t_regression',
    title: 'Monotonic t regression detected',
    severity: 'medium',
    confidence: 1.0,
    fallbackDescription:
      'One or more events have a t value smaller than a preceding event in the same session. The recorder clock may have been manipulated.',
  },
  monotonic_wall: {
    heuristic: 'monotonic_wall_regression',
    title: 'Monotonic wall-clock regression detected',
    severity: 'medium',
    confidence: 1.0,
    fallbackDescription:
      'One or more events have a wall timestamp earlier than a preceding event in the same session. The system clock may have been adjusted backwards.',
  },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert failing ValidationReport checks (1, 2, 3, 5, 6) into Flag objects.
 *
 * The check's `supportingSeqs` field contains `{ sessionId, seq }` pairs
 * that identify the exact entries where failures were detected. We convert
 * them to `${sessionId}:${seq}` strings (EventIndex.bySeq key format) for
 * UI deep-linking.
 */
export function integrityFlagsFromReport(report: ValidationReport): Flag[] {
  const flags: Flag[] = [];

  for (const check of report.checks) {
    if (check.status !== 'fail') continue;

    const meta = CHECK_META[check.id];
    if (meta === undefined) continue;

    const rawSeqs = check.supportingSeqs ?? [];
    const supportingSeqs = rawSeqs.map((s) => `${s.sessionId}:${s.seq}`);

    // Deterministic flag id: derived from the first supporting seq (or the
    // check id alone if no seqs are available).
    const seqKey0 = supportingSeqs[0] ?? 'no-seq';
    const id = `${meta.heuristic}-${seqKey0}`;

    flags.push({
      id,
      heuristic: meta.heuristic,
      title: meta.title,
      severity: meta.severity,
      confidence: meta.confidence,
      supportingSeqs,
      description: check.detail ?? meta.fallbackDescription,
      detail: {
        checkId: check.id,
        checkLabel: check.label,
        entryCount: rawSeqs.length,
      },
    });
  }

  return flags;
}
