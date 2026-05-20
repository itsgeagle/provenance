/**
 * replay-decoration-utils.ts — pure helper functions for Phase 14 gutter
 * decorations and hover attribution.
 *
 * These are separated from the React components so they can be unit-tested
 * without any Monaco or DOM setup.
 *
 * PRD ref: §7.2 (color-coded gutter, hover line attribution).
 */

import { linesWithProvenance } from '../../index/provenance-utils.js';
import type { FileReplayState, ProvenanceKind } from '../../index/reconstruct-file-provenance.js';
import type { IndexedEvent } from '../../index/event-index.js';

// ---------------------------------------------------------------------------
// Run computation
// ---------------------------------------------------------------------------

/**
 * A contiguous run of characters in the file that all map to the same
 * ProvenanceKind. The range is expressed as 1-based Monaco line/column
 * coordinates (Monaco is 1-based).
 */
export type DecorationRun = {
  kind: 'paste' | 'external_change'; // 'typed' runs are unstyled — omitted
  /** 1-based start line number. */
  startLineNumber: number;
  /** 1-based start column (inclusive). */
  startColumn: number;
  /** 1-based end line number. */
  endLineNumber: number;
  /** 1-based end column (exclusive). */
  endColumn: number;
};

/**
 * Compute decoration runs from a `FileReplayState`.
 *
 * Algorithm: iterate `linesWithProvenance(state)` once, emitting a new run
 * whenever the kind changes. Only paste and external_change runs are returned;
 * typed regions produce no decoration.
 *
 * Invariant (from reconstruct-file-provenance, A33):
 *   `external_change` entries in `kindByGlobalIdx` are sentinels — no character
 *   in `provenance` will equal that globalIdx (the file was cleared). So runs
 *   with kind=external_change will never appear here (provenance chars reference
 *   typed/paste events). This function handles the mapping correctly: if
 *   `kindByGlobalIdx.get(gi)` returns `'external_change'`, we still emit the
 *   run — but in practice that path is unreachable for non-empty files, because
 *   external_change clears `provenance`. The function is correct regardless.
 *
 * @param state   FileReplayState at the current engine position.
 * @returns       Array of DecorationRun (may be empty if file is empty or all typed).
 */
export function runsFromProvenance(state: FileReplayState): DecorationRun[] {
  if (state.content.length === 0) return [];

  const lines = linesWithProvenance(state);
  const result: DecorationRun[] = [];

  // Current open run (if any).
  let currentKind: 'paste' | 'external_change' | null = null;
  let runStartLine = 1; // 1-based
  let runStartCol = 1; // 1-based

  function closeRun(endLine: number, endCol: number) {
    if (currentKind === null) return;
    result.push({
      kind: currentKind,
      startLineNumber: runStartLine,
      startColumn: runStartCol,
      endLineNumber: endLine,
      endColumn: endCol,
    });
    currentKind = null;
  }

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx]!;
    const lineNumber = lineIdx + 1; // 1-based

    for (let charIdx = 0; charIdx < line.provenance.length; charIdx++) {
      const gi = line.provenance[charIdx]!;
      const kind = state.kindByGlobalIdx.get(gi);
      const effectiveKind: 'paste' | 'external_change' | 'typed' = kind ?? 'typed';

      if (effectiveKind === 'typed') {
        // Close any open non-typed run.
        if (currentKind !== null) {
          closeRun(lineNumber, charIdx + 1); // endColumn is exclusive
        }
      } else {
        // paste or external_change
        if (currentKind === effectiveKind) {
          // Continue the current run — do nothing, will extend when closed.
        } else {
          // Close previous run (if any) and start a new one.
          if (currentKind !== null) {
            closeRun(lineNumber, charIdx + 1);
          }
          currentKind = effectiveKind;
          runStartLine = lineNumber;
          runStartCol = charIdx + 1; // 1-based
        }
      }
    }

    // At end of line (before the newline character):
    // If there's a run in progress, we need to close at the end of this line
    // if the NEXT line starts a different kind (or if this is the last line).
    // However, we must NOT close the run mid-line just because a newline is
    // coming — a paste can span multiple lines. So we don't close at line
    // boundaries; we only close on kind-changes. The close happens when:
    //   (a) the next character's kind differs, OR
    //   (b) we reach the last character of the entire content.
    //
    // For multi-line runs the endColumn at line break is handled by Monaco's
    // decoration model: a range {startLine:1,startCol:1, endLine:2,endCol:5}
    // covers the newline between them. We let the loop handle closing naturally.
  }

  // Close any open run at the end of the content.
  if (currentKind !== null) {
    const lastLine = lines.length;
    const lastCol = (lines[lines.length - 1]?.provenance.length ?? 0) + 1;
    closeRun(lastLine, lastCol);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Hover content
// ---------------------------------------------------------------------------

/**
 * Format the hover string for a given character offset in the file.
 *
 * Returns `null` if:
 *   - `offset` is out of range.
 *   - The provenance entry has no event (shouldn't happen; defensive).
 *
 * The returned string is in Monaco Markdown format so it renders nicely in
 * the hover widget. We use a plain code-style string for simplicity.
 *
 * @param offset        Flat character offset into `state.content`.
 * @param state         FileReplayState at the current engine position.
 * @param orderedEvents All events in the bundle, chronologically ordered.
 */
export function hoverContentFor(
  offset: number,
  state: FileReplayState,
  orderedEvents: readonly IndexedEvent[],
): string | null {
  if (offset < 0 || offset >= state.provenance.length) return null;

  const gi = state.provenance[offset];
  if (gi === undefined) return null;

  // Look up kind.
  const kind: ProvenanceKind = state.kindByGlobalIdx.get(gi) ?? 'typed';

  // Find the event by globalIdx. The ordered array is indexed by globalIdx
  // (ordered[gi].globalIdx === gi by build-index invariant), so direct access
  // is O(1). Fallback to linear search for robustness.
  const event: IndexedEvent | undefined =
    orderedEvents[gi] ?? orderedEvents.find((e) => e.globalIdx === gi);
  if (event === undefined) return null;

  return `Last modified at t=${event.t}ms, kind=${kind}, seq=#${event.seq}`;
}
