/**
 * Extract submitted files from a stored bundle blob on demand.
 *
 * Student source is NEVER persisted in Postgres — it is read from the blob
 * each time this function is called and dropped after the response is sent.
 *
 * Design:
 *   - `extractSubmittedFiles` returns the per-file verdict list (path, status,
 *     verdict, sha256) for the Source tab file list.
 *   - `extractSubmittedFileContent` returns the UTF-8 bytes of one file plus
 *     its verdict (for the Source tab content panel).
 *
 * Both functions return graceful empty/null results when the bundle has no
 * submission files (1.0 format) or when a specific file is not present.
 *
 * Retention contract: callers return `available:false` / 404 when the blob
 * is gone (swept by retention). These functions never receive a null buffer.
 */

import { loadBundle } from '@provenance/analysis-core/loader/parse-bundle.js';
import { runValidation } from '@provenance/analysis-core/validation/run-validation.js';
import { submittedFileVerdicts } from '@provenance/analysis-core/validation/verify-submitted-code.js';
import type { SubmittedFileList, SubmittedFileContent } from '@provenance/shared/api-schemas';

// ---------------------------------------------------------------------------
// extractSubmittedFiles
// ---------------------------------------------------------------------------

/**
 * Parse `blob`, run validation, and return per-file verdicts.
 *
 * Returns `{ available: true, files: [] }` when:
 *   - The bundle fails to parse (corrupt / unexpected format).
 *   - The bundle is format 1.0 (no submission_files in manifest).
 */
export async function extractSubmittedFiles(blob: ArrayBuffer): Promise<SubmittedFileList> {
  const parsed = await loadBundle(blob, 'bundle.zip');
  if (!parsed.ok) return { available: true, files: [] };

  const bundle = parsed.value;
  const report = await runValidation(bundle);
  const chainIntact = report.checks.find((c) => c.id === 'chain_integrity')?.status === 'pass';
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
 * Parse `blob` and return the UTF-8 content + verdict for `path`.
 *
 * Returns `null` when:
 *   - The bundle fails to parse.
 *   - The path is not in `bundle.submissionFiles`.
 *   - The file has status 'missing' (not present on disk at seal time).
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
  const verdicts = submittedFileVerdicts(bundle, { chainIntact: chainIntact ?? false });
  const v = verdicts.find((x) => x.path === path);

  const content = entry.bytes !== undefined ? new TextDecoder().decode(entry.bytes) : '';
  return {
    path,
    content,
    status: entry.status,
    verdict: v?.verdict ?? 'unknown',
  };
}
