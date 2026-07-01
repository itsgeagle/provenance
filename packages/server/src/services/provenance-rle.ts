/**
 * Provenance run-length encoder — Phase 18 (PRD §8.9 line 1238).
 *
 * Compresses the per-character provenance array into a compact run-length
 * encoded form suitable for API transport.
 *
 * A "run" groups consecutive characters that share the same (globalIdx, kind)
 * pair. A new run begins whenever either the globalIdx OR the kind changes.
 *
 * Wire shape per PRD §8.9:
 *   { offset: int, length: int, kind: ProvenanceKind, event_seq: int }
 *
 * `event_seq` is the globalIdx of the event that last wrote those characters.
 */

import type { ProvenanceKind } from '@provenance/analysis-core/index/reconstruct-file-provenance.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProvenanceRun = {
  /** Zero-based char offset in the content string where this run starts. */
  offset: number;
  /** Number of characters in this run. */
  length: number;
  /** Provenance kind for every character in this run. */
  kind: ProvenanceKind;
  /** globalIdx (events.seq) of the event that last wrote these characters. */
  event_seq: number;
};

// ---------------------------------------------------------------------------
// encodeRle
// ---------------------------------------------------------------------------

/**
 * Encode a flat provenance array + kind map into run-length encoded runs.
 *
 * Algorithm:
 *   Walk `provenance` left-to-right. Emit a new run whenever the current
 *   globalIdx or its kind (from `kindByGlobalIdx`) differs from the last run.
 *
 * Edge cases:
 *   - Empty provenance → [].
 *   - globalIdx not in kindByGlobalIdx → defaults to 'typed'
 *     (should not happen with valid bundles; defensive fallback).
 *
 * @param provenance     - Per-character globalIdx values.
 * @param kindByGlobalIdx - Maps globalIdx → ProvenanceKind.
 */
export function encodeRle(
  provenance: number[],
  kindByGlobalIdx: Map<number, ProvenanceKind>,
): ProvenanceRun[] {
  if (provenance.length === 0) return [];

  const runs: ProvenanceRun[] = [];

  let runStart = 0;
  let currentIdx = provenance[0]!;
  let currentKind: ProvenanceKind = kindByGlobalIdx.get(currentIdx) ?? 'typed';

  for (let i = 1; i < provenance.length; i++) {
    const idx = provenance[i]!;
    const kind: ProvenanceKind = kindByGlobalIdx.get(idx) ?? 'typed';

    if (idx !== currentIdx || kind !== currentKind) {
      // Flush the current run.
      runs.push({
        offset: runStart,
        length: i - runStart,
        kind: currentKind,
        event_seq: currentIdx,
      });
      runStart = i;
      currentIdx = idx;
      currentKind = kind;
    }
  }

  // Flush the final run.
  runs.push({
    offset: runStart,
    length: provenance.length - runStart,
    kind: currentKind,
    event_seq: currentIdx,
  });

  return runs;
}
