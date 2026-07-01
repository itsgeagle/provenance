/**
 * Serve the analyzer's "Source" tab from a stored (provenance-only) bundle blob.
 *
 * Student source bytes are no longer stored: ingest strips them from the bundle
 * before persisting it (only the signed manifest + .slog logs remain). So:
 *
 *   - The file LIST + per-file verdicts come from the signed manifest
 *     (submission_files: path/status/sha256) compared against the recorded
 *     on-disk hashes in the event stream. Because the manifest is
 *     signature-verified (validation check 1) and the source bytes were removed
 *     deliberately, we trust the manifest sha256 for present files (loadBundle's
 *     byte-vs-manifest `hashOk` is necessarily false with the bytes gone). This
 *     reproduces the ingest-time verdict for every normal case; the one case it
 *     cannot reproduce — bytes tampered without touching the manifest — is caught
 *     at ingest and recorded in validation_results.check_8_status.
 *
 *   - File CONTENT is reconstructed from the event stream (replay to the end of
 *     the recording), not read from raw bytes. For a `match` verdict this equals
 *     the submitted source; for a `mismatch` it is the recorded final state
 *     (which, by definition, differs from what was submitted).
 *
 * Retention contract: callers return `available:false` / 404 when the blob is
 * gone (swept by retention). These functions never receive a null buffer.
 */

import { loadBundle } from '@provenance/analysis-core/loader/parse-bundle.js';
import { runValidation } from '@provenance/analysis-core/validation/run-validation.js';
import { submittedFileVerdicts } from '@provenance/analysis-core/validation/verify-submitted-code.js';
import { buildIndex } from '@provenance/analysis-core/index/build-index.js';
import { reconstructFileWithProvenance } from '@provenance/analysis-core/index/reconstruct-file-provenance.js';
import type { Bundle } from '@provenance/analysis-core/loader/types.js';
import type { SubmittedFileList, SubmittedFileContent } from '@provenance/shared/api-schemas';

/**
 * Trust the signed manifest sha256 for present submission files.
 *
 * The stored bundle is source-stripped, so loadBundle's `hashOk` (which re-hashes
 * the zip bytes against the manifest) is false for every present file. The
 * manifest is signature-verified, so we set hashOk=true to reproduce the
 * ingest-time verdict (manifest sha vs recorded on-disk hash) instead of a
 * spurious "tampered bundle" mismatch caused solely by the absent bytes.
 */
function trustManifestShas(bundle: Bundle): void {
  for (const entry of bundle.submissionFiles.values()) {
    if (entry.status === 'present') entry.hashOk = true;
  }
}

// ---------------------------------------------------------------------------
// extractSubmittedFiles
// ---------------------------------------------------------------------------

/**
 * Parse `blob` and return per-file verdicts for the Source tab file list.
 *
 * Returns `{ available: true, files: [] }` when the bundle fails to parse or is
 * format 1.0 (no submission_files in the manifest).
 */
export async function extractSubmittedFiles(blob: ArrayBuffer): Promise<SubmittedFileList> {
  const parsed = await loadBundle(blob, 'bundle.zip');
  if (!parsed.ok) return { available: true, files: [] };

  const bundle = parsed.value;
  const report = await runValidation(bundle);
  const chainIntact = report.checks.find((c) => c.id === 'chain_integrity')?.status === 'pass';
  trustManifestShas(bundle);
  const verdicts = submittedFileVerdicts(bundle, { chainIntact: chainIntact ?? false });

  return {
    available: true,
    files: verdicts.map((v) => ({
      path: v.path,
      status: v.status,
      verdict: v.verdict,
      sha256: v.submittedSha,
    })),
  };
}

// ---------------------------------------------------------------------------
// extractSubmittedFileContent
// ---------------------------------------------------------------------------

/**
 * Parse `blob` and return the reconstructed content + verdict for `path`.
 *
 * Returns `null` when the bundle fails to parse, the path is not listed in the
 * manifest's submission_files, or the file was 'missing' at seal time.
 */
export async function extractSubmittedFileContent(
  blob: ArrayBuffer,
  path: string,
): Promise<SubmittedFileContent | null> {
  const parsed = await loadBundle(blob, 'bundle.zip');
  if (!parsed.ok) return null;

  const bundle = parsed.value;
  const entry = bundle.submissionFiles.get(path);
  if (entry === undefined) return null;
  if (entry.status === 'missing') return null;

  const report = await runValidation(bundle);
  const chainIntact = report.checks.find((c) => c.id === 'chain_integrity')?.status === 'pass';
  trustManifestShas(bundle);
  const verdicts = submittedFileVerdicts(bundle, { chainIntact: chainIntact ?? false });
  const v = verdicts.find((x) => x.path === path);

  // Content is reconstructed from the event stream (replay to the end), since the
  // raw source bytes are no longer stored.
  const index = buildIndex(bundle);
  const content = reconstructFileWithProvenance(index, path).content;

  return {
    path,
    content,
    status: entry.status,
    verdict: v?.verdict ?? 'unknown',
  };
}
