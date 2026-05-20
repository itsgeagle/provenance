/**
 * provenance-utils — helpers built on top of FileReplayState (Phase 12).
 *
 * These are pure projections used by:
 *   - Phase 14 replay UI's gutter overlay (`colorForGlobalIdx`,
 *     `lineLastTouchedAt`).
 *   - Phase 14 hover provider (`linesWithProvenance`).
 *
 * Keeping them in the index layer (not in views/replay) means non-UI
 * consumers — Phase 16's `paste_is_solution`, the future PDF export — can
 * use them without dragging in React.
 */

import type { FileReplayState, ProvenanceKind } from './reconstruct-file-provenance.js';

// ---------------------------------------------------------------------------
// linesWithProvenance
// ---------------------------------------------------------------------------

export type LineWithProvenance = {
  /** The text of the line, NOT including the trailing newline. */
  text: string;
  /**
   * Per-character `globalIdx` for this line, length === text.length.
   * Returned as `number[]` (not `Uint32Array`) because consumers typically
   * iterate / reduce, and `number[]` is the more ergonomic shape at the
   * boundary.
   */
  provenance: number[];
};

/**
 * Project `state.content` + `state.provenance` into per-line slices.
 *
 * Splits on `\n` (consistent with v1's positionToOffset model). The
 * trailing-newline edge case: if content ends with `\n`, the last array
 * entry is an empty line (matching `String.prototype.split('\n')`).
 */
export function linesWithProvenance(state: FileReplayState): LineWithProvenance[] {
  const out: LineWithProvenance[] = [];
  const text = state.content;
  const prov = state.provenance;

  let lineStart = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text.charCodeAt(i) === 0x0a /* \n */) {
      const lineText = text.slice(lineStart, i);
      const lineProv: number[] = [];
      for (let j = lineStart; j < i; j++) {
        lineProv.push(prov[j]!);
      }
      out.push({ text: lineText, provenance: lineProv });
      lineStart = i + 1;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// colorForGlobalIdx
// ---------------------------------------------------------------------------

/**
 * Look up the `ProvenanceKind` that wrote characters tagged with `gi`.
 *
 * Returns `null` if the event isn't in `kindByGlobalIdx` (e.g. caller passed
 * a globalIdx that never wrote any characters, or the file was cleared by
 * a taint event before this gi). The consumer maps the kind → CSS class /
 * color elsewhere; this helper stays purely semantic so it can be unit-
 * tested without involving the UI layer.
 */
export function colorForGlobalIdx(state: FileReplayState, gi: number): ProvenanceKind | null {
  return state.kindByGlobalIdx.get(gi) ?? null;
}

// ---------------------------------------------------------------------------
// lineLastTouchedAt
// ---------------------------------------------------------------------------

/**
 * Return the maximum `globalIdx` in the given line's provenance array,
 * i.e. the most recent event that touched any character on that line.
 *
 * Returns `null` if the line is empty (no characters → no provenance) or
 * if the line index is out of range. Used by Phase 14's hover provider to
 * show "this line last edited by event #N" without forcing the UI to
 * iterate the per-char array itself.
 */
export function lineLastTouchedAt(state: FileReplayState, line: number): number | null {
  const lines = linesWithProvenance(state);
  const target = lines[line];
  if (!target || target.provenance.length === 0) return null;
  let max = target.provenance[0]!;
  for (let i = 1; i < target.provenance.length; i++) {
    const v = target.provenance[i]!;
    if (v > max) max = v;
  }
  return max;
}
