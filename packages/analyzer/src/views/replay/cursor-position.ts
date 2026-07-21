/**
 * cursor-position.ts — pure helpers behind the replay cursor marker.
 *
 *   currentSelection() — the student's most recent cursor/selection for the active
 *                        file at-or-before the playhead.
 *   toMonacoRange()    — convert a recorder Range (0-based LSP) to a Monaco range
 *                        literal (1-based).
 *
 * Both are pure (no React, no Monaco). Recorder PRD §4.2 (selection.change).
 */

import type { IndexedEvent } from '@provenance/analysis-core/index/event-index.js';
import type { SelectionChangePayload, Range } from '@provenance/log-core';

/** The student's cursor/selection at a point in replay. */
export type ReplaySelection = {
  /** Recorder Range (0-based LSP coordinates). */
  range: Range;
  /** True when the student had text selected (start !== end). */
  wasSelection: boolean;
};

/**
 * The most recent `selection.change` for `filePath` at-or-before the playhead, or
 * null (no such event yet, or `filePath` is null). `events` must be chronologically
 * ordered (ascending `globalIdx`), as the per-session event lists are.
 */
export function currentSelection(
  events: readonly IndexedEvent[],
  currentGlobalIdx: number,
  filePath: string | null,
): ReplaySelection | null {
  if (filePath === null) return null;
  let result: ReplaySelection | null = null;
  for (const e of events) {
    if (e.globalIdx > currentGlobalIdx) break;
    if (e.kind !== 'selection.change' || e.file !== filePath) continue;
    const p = e.payload as SelectionChangePayload;
    result = { range: p.range, wasSelection: p.was_selection };
  }
  return result;
}

/** A Monaco range literal (1-based), matching `IModelDeltaDecoration['range']`. */
export type MonacoRangeLiteral = {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
};

/** Convert a recorder Range (0-based LSP) to a Monaco range literal (1-based). */
export function toMonacoRange(range: Range): MonacoRangeLiteral {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}

/** A Monaco position literal (1-based), matching `IPosition`. */
export type MonacoPositionLiteral = {
  lineNumber: number;
  column: number;
};

/**
 * Where the student's caret sits for a selection: at the selection END for a
 * real selection, else at the (equal) start/end of a bare cursor.
 *
 * Shared by CursorMarker (which paints the caret) and FollowCursor (which
 * scrolls it into view) so the painted and revealed positions cannot drift.
 */
export function caretPosition(selection: ReplaySelection): MonacoPositionLiteral {
  const m = toMonacoRange(selection.range);
  return selection.wasSelection
    ? { lineNumber: m.endLineNumber, column: m.endColumn }
    : { lineNumber: m.startLineNumber, column: m.startColumn };
}
