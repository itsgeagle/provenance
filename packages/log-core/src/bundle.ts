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

export type SubmissionFileEntry = {
  /** Workspace-relative path; matches a files_under_review entry. */
  path: string;
  /** 'present' = bytes are in the bundle; 'missing' = listed but absent on disk at seal. */
  status: 'present' | 'missing';
  /** Hex sha256 of the raw on-disk bytes. null iff status === 'missing'. */
  sha256: string | null;
};

export type BundleManifest = {
  /**
   * '1.0' = legacy bundles (no submission_files). '1.1' = carries the final
   * on-disk state of every files_under_review entry. The validator accepts both;
   * `submission_files` is therefore optional at the type level (absent on 1.0).
   */
  format_version: '1.0' | '1.1';
  assignment_id: string;
  semester: string;
  /** Hex sha256 of the recorder extension. */
  extension_hash: string;
  sessions: ReadonlyArray<{
    /**
     * The session UUID from the session.start event.
     * null when the .slog could not be parsed (corrupt/truncated session).
     */
    session_id: string | null;
    prev_session_id: string | null;
    /** Hex sha256 of the .slog file. */
    slog_sha256: string;
    /** Hex sha256 of the .slog.meta file. */
    meta_sha256: string;
  }>;
  /**
   * Final on-disk state of every files_under_review entry (PRD §5.3, 1.1+).
   * Absent (undefined) on legacy 1.0 bundles — read as `submission_files ?? []`.
   */
  submission_files?: ReadonlyArray<SubmissionFileEntry>;
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
      | 'session_pubkey_bound_to_manifest_sig'
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

  // format_version: accept 1.0 (legacy, no submission_files) and 1.1.
  const version = obj['format_version'];
  if (version !== '1.0' && version !== '1.1') {
    return err({ kind: 'wrong_version', actual: version });
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
  if (typeof obj['extension_hash'] !== 'string' || !HEX_64_RE.test(obj['extension_hash'])) {
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

    if (
      sObj['session_id'] !== null &&
      (typeof sObj['session_id'] !== 'string' || sObj['session_id'].length === 0)
    ) {
      if (sObj['session_id'] === undefined) {
        return err({ kind: 'missing_field', field: `sessions[${i}].session_id` });
      }
      return err({
        kind: 'invalid_field',
        field: `sessions[${i}].session_id`,
        reason: 'must be a non-empty string or null',
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

    if (typeof sObj['slog_sha256'] !== 'string' || !HEX_64_RE.test(sObj['slog_sha256'])) {
      if (sObj['slog_sha256'] === undefined) {
        return err({ kind: 'missing_field', field: `sessions[${i}].slog_sha256` });
      }
      return err({
        kind: 'invalid_field',
        field: `sessions[${i}].slog_sha256`,
        reason: 'must be 64 hex chars',
      });
    }

    if (typeof sObj['meta_sha256'] !== 'string' || !HEX_64_RE.test(sObj['meta_sha256'])) {
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

  // submission_files: required iff format_version === '1.1'. Absent on legacy 1.0.
  if (version === '1.1') {
    if (!Array.isArray(obj['submission_files'])) {
      if (obj['submission_files'] === undefined) {
        return err({ kind: 'missing_field', field: 'submission_files' });
      }
      return err({ kind: 'invalid_field', field: 'submission_files', reason: 'must be an array' });
    }
    for (let i = 0; i < obj['submission_files'].length; i++) {
      const f = (obj['submission_files'] as unknown[])[i];
      if (typeof f !== 'object' || f === null) {
        return err({
          kind: 'invalid_field',
          field: `submission_files[${i}]`,
          reason: 'must be an object',
        });
      }
      const fObj = f as Record<string, unknown>;
      if (typeof fObj['path'] !== 'string' || fObj['path'].length === 0) {
        return err({
          kind: 'invalid_field',
          field: `submission_files[${i}].path`,
          reason: 'must be a non-empty string',
        });
      }
      const status = fObj['status'];
      if (status !== 'present' && status !== 'missing') {
        return err({
          kind: 'invalid_field',
          field: `submission_files[${i}].status`,
          reason: "must be 'present' or 'missing'",
        });
      }
      const sha = fObj['sha256'];
      if (status === 'present') {
        if (typeof sha !== 'string' || !HEX_64_RE.test(sha)) {
          return err({
            kind: 'invalid_field',
            field: `submission_files[${i}].sha256`,
            reason: 'present file must have a 64-hex sha256',
          });
        }
      } else {
        if (sha !== null) {
          return err({
            kind: 'invalid_field',
            field: `submission_files[${i}].sha256`,
            reason: 'missing file must have sha256 === null',
          });
        }
      }
    }
  }

  return ok(value as BundleManifest);
}
