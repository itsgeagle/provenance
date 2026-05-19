/**
 * Types and shape-validator for the bundle manifest.json.
 * PRD §5.3 (bundle format), §5.4 (validation report shape).
 *
 * No I/O — types and validateBundleManifestShape only.
 */

import { ok, err } from './result.js';
import type { Result } from './result.js';

// ---------------------------------------------------------------------------
// Error type (same pattern as MetaShapeError)
// ---------------------------------------------------------------------------

export type BundleShapeError =
  | { kind: 'not_object' }
  | { kind: 'wrong_version'; actual: unknown }
  | { kind: 'missing_field'; field: string }
  | { kind: 'invalid_field'; field: string; reason: string };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BundleManifest = {
  format_version: '1.0';
  assignment_id: string;
  semester: string;
  /** Hex sha256 of the recorder extension. */
  extension_hash: string;
  sessions: ReadonlyArray<{
    session_id: string;
    prev_session_id: string | null;
    /** Hex sha256 of the .slog file. */
    slog_sha256: string;
    /** Hex sha256 of the .slog.meta file. */
    meta_sha256: string;
  }>;
};

/**
 * Validation report produced by the Analyzer after loading a bundle.
 * PRD §5.4 — what the analyzer emits after running all checks.
 *
 * This is an output type only; there is no validateBundleManifestShape for it.
 */
export type ValidationReport = {
  steps: ReadonlyArray<{
    step:
      | 'manifest_signature'
      | 'session_pubkey_bound_to_cs61a_sig'
      | 'hash_chain_intact'
      | 'no_seq_gaps'
      | 't_monotonic'
      | 'wall_monotonic_modulo_skew'
      | 'doc_save_hashes_consistent'
      | 'final_file_hashes_match_submission';
    ok: boolean;
    detail?: string;
  }>;
};

// ---------------------------------------------------------------------------
// Regex helper
// ---------------------------------------------------------------------------

const HEX_64_RE = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// Shape validator
// ---------------------------------------------------------------------------

/**
 * Validate that an unknown value has the BundleManifest shape.
 */
export function validateBundleManifestShape(
  value: unknown,
): Result<BundleManifest, BundleShapeError> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return err({ kind: 'not_object' });
  }

  const obj = value as Record<string, unknown>;

  // format_version
  if (obj['format_version'] !== '1.0') {
    return err({ kind: 'wrong_version', actual: obj['format_version'] });
  }

  // assignment_id
  if (typeof obj['assignment_id'] !== 'string' || obj['assignment_id'].length === 0) {
    if (obj['assignment_id'] === undefined) {
      return err({ kind: 'missing_field', field: 'assignment_id' });
    }
    return err({
      kind: 'invalid_field',
      field: 'assignment_id',
      reason: 'must be a non-empty string',
    });
  }

  // semester
  if (typeof obj['semester'] !== 'string' || obj['semester'].length === 0) {
    if (obj['semester'] === undefined) {
      return err({ kind: 'missing_field', field: 'semester' });
    }
    return err({ kind: 'invalid_field', field: 'semester', reason: 'must be a non-empty string' });
  }

  // extension_hash: 64 hex chars
  if (!HEX_64_RE.test(obj['extension_hash'] as string)) {
    if (obj['extension_hash'] === undefined) {
      return err({ kind: 'missing_field', field: 'extension_hash' });
    }
    return err({
      kind: 'invalid_field',
      field: 'extension_hash',
      reason: 'must be 64 lowercase hex chars (sha256)',
    });
  }

  // sessions: array
  if (!Array.isArray(obj['sessions'])) {
    if (obj['sessions'] === undefined) {
      return err({ kind: 'missing_field', field: 'sessions' });
    }
    return err({ kind: 'invalid_field', field: 'sessions', reason: 'must be an array' });
  }

  for (let i = 0; i < obj['sessions'].length; i++) {
    const s = (obj['sessions'] as unknown[])[i];
    if (typeof s !== 'object' || s === null) {
      return err({ kind: 'invalid_field', field: `sessions[${i}]`, reason: 'must be an object' });
    }
    const sObj = s as Record<string, unknown>;

    if (typeof sObj['session_id'] !== 'string' || sObj['session_id'].length === 0) {
      if (sObj['session_id'] === undefined) {
        return err({ kind: 'missing_field', field: `sessions[${i}].session_id` });
      }
      return err({
        kind: 'invalid_field',
        field: `sessions[${i}].session_id`,
        reason: 'must be a non-empty string',
      });
    }

    // prev_session_id: string | null
    if (sObj['prev_session_id'] !== null && typeof sObj['prev_session_id'] !== 'string') {
      if (sObj['prev_session_id'] === undefined) {
        return err({ kind: 'missing_field', field: `sessions[${i}].prev_session_id` });
      }
      return err({
        kind: 'invalid_field',
        field: `sessions[${i}].prev_session_id`,
        reason: 'must be a string or null',
      });
    }

    if (!HEX_64_RE.test(sObj['slog_sha256'] as string)) {
      if (sObj['slog_sha256'] === undefined) {
        return err({ kind: 'missing_field', field: `sessions[${i}].slog_sha256` });
      }
      return err({
        kind: 'invalid_field',
        field: `sessions[${i}].slog_sha256`,
        reason: 'must be 64 hex chars',
      });
    }

    if (!HEX_64_RE.test(sObj['meta_sha256'] as string)) {
      if (sObj['meta_sha256'] === undefined) {
        return err({ kind: 'missing_field', field: `sessions[${i}].meta_sha256` });
      }
      return err({
        kind: 'invalid_field',
        field: `sessions[${i}].meta_sha256`,
        reason: 'must be 64 hex chars',
      });
    }
  }

  return ok(value as BundleManifest);
}
