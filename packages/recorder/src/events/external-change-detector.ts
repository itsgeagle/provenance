/**
 * external-change-detector.ts — pure comparison of expected vs on-disk content.
 * Called from the doc.save path (doc-wiring.ts) to detect external edits.
 *
 * PRD §4.5: "When a doc.save fires, compute the on-disk sha256 and compare it
 * to our expected hash."
 *
 * IMPORTANT: This function does NOT mutate `expected`. The caller is responsible
 * for calling `expected.reset(onDiskContent)` after recording the fs.external_change
 * event so that subsequent edits chain from reality (CLAUDE.md + PRD §4.5).
 */

import { sha256Hex } from '@provenance/log-core';
import type { ExpectedContent } from '../state/expected-content.js';

// ---------------------------------------------------------------------------
// Return type
// ---------------------------------------------------------------------------

export type ExternalChangeResult =
  | { kind: 'clean_save'; new_hash: string }
  | { kind: 'external_change'; old_hash: string; new_hash: string; diff_size: number };

// ---------------------------------------------------------------------------
// compareSavedContent
// ---------------------------------------------------------------------------

/**
 * Compare the on-disk content of a saved file against the in-memory expected
 * content model.
 *
 * @param expected - The in-memory expected content (from ExpectedContentRegistry).
 * @param onDiskContent - The actual content read from disk after save.
 * @returns `clean_save` if hashes match; `external_change` with diff information otherwise.
 *
 * diff_size is an approximation: |onDiskContent.length - expected.content.length|.
 * A real diff algorithm (LCS / Myers) is out of scope for Phase 7; this is only
 * used to populate the `diff_size` field in FsExternalChangePayload and gives the
 * Analyzer a rough sense of how much the file changed. For whole-file replacements
 * the value is meaningful; for small in-place edits it may be 0 even when content
 * diverged (same length, different bytes). Document this limitation in the PRD-§4.5
 * review if it matters for heuristics.
 */
export function compareSavedContent(
  expected: ExpectedContent,
  onDiskContent: string,
): ExternalChangeResult {
  const actualHash = sha256Hex(onDiskContent);
  const expectedHash = expected.hash;

  if (actualHash === expectedHash) {
    return { kind: 'clean_save', new_hash: actualHash };
  }

  // Approximation: absolute difference in byte lengths.
  // Phase 7 does not need a real diff algorithm (see docstring above).
  const diff_size = Math.abs(onDiskContent.length - expected.content.length);

  return {
    kind: 'external_change',
    old_hash: expectedHash,
    new_hash: actualHash,
    diff_size,
  };
}
