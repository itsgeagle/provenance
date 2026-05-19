/**
 * Types for the validation pipeline (Phase 2).
 * PRD §5.4 — 8 checks in spec order.
 */

// ---------------------------------------------------------------------------
// Check ID enum
// ---------------------------------------------------------------------------

export type ValidationCheckId =
  | 'manifest_sig'
  | 'session_binding'
  | 'chain_integrity'
  | 'seq_gaps'
  | 'monotonic_t'
  | 'monotonic_wall'
  | 'doc_save_hashes'
  | 'submitted_code_match';

// ---------------------------------------------------------------------------
// Single check result
// ---------------------------------------------------------------------------

export type ValidationCheck = {
  id: ValidationCheckId;
  /** Human-readable name for the check. */
  label: string;
  status: 'pass' | 'fail' | 'skipped';
  /** Optional prose detail: explains failure reason or skipped rationale. */
  detail?: string;
  /** Session-local seqs of entries that contributed to a failure. */
  supportingSeqs?: Array<{ sessionId: string; seq: number }>;
};

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/**
 * Full validation report — always exactly 8 entries in PRD §5.4 spec order.
 *
 * `overall` rules:
 *   - Any 'fail' check → 'fail'.
 *   - No 'fail' but ≥1 'skipped' → 'warn'.
 *   - All 'pass' → 'pass'.
 *
 * NOTE: In v1, check 8 (submitted_code_match) is always 'skipped', so the
 * best a real bundle can score in v1 is 'warn'. This is by design — v1 does
 * not have course-staff final-file hashes to compare against.
 */
export type ValidationReport = {
  checks: ValidationCheck[];
  overall: 'pass' | 'warn' | 'fail';
};
