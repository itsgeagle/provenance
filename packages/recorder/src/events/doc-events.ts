/**
 * Pure transformers: VS Code event + context → log-core payload.
 * NO I/O. NO global state. Testable without a real VS Code runtime.
 *
 * PRD §4.2: doc.*, selection.change, focus.change events.
 * CLAUDE.md: "test the event-to-log-entry transformation as a pure function,
 *             separately from the VS Code wiring."
 */

import type * as vscode from 'vscode';
import type {
  DocOpenPayload,
  DocChangePayload,
  DocSavePayload,
  DocClosePayload,
  SelectionChangePayload,
  FocusChangePayload,
} from '@provenance/log-core';

// ---------------------------------------------------------------------------
// WorkspaceLike — minimal seam so tests don't need a real vscode.workspace
// ---------------------------------------------------------------------------

export type WorkspaceLike = {
  asRelativePath: (uri: vscode.Uri) => string;
};

// ---------------------------------------------------------------------------
// Transformers
// ---------------------------------------------------------------------------

/** Build a doc.open payload from a VS Code TextDocument. */
export function transformDocOpen(
  document: vscode.TextDocument,
  workspace: WorkspaceLike,
  contentHash: string,
): DocOpenPayload {
  return {
    path: workspace.asRelativePath(document.uri),
    sha256: contentHash,
    line_count: document.lineCount,
  };
}

/**
 * Build a doc.change payload from a VS Code TextDocumentChangeEvent.
 * source is hardcoded to 'typed' in Phase 5; Phase 6 (paste detection) will refine.
 */
export function transformDocChange(
  event: vscode.TextDocumentChangeEvent,
  workspace: WorkspaceLike,
): DocChangePayload {
  return {
    path: workspace.asRelativePath(event.document.uri),
    deltas: event.contentChanges.map((change) => ({
      range: {
        start: { line: change.range.start.line, character: change.range.start.character },
        end: { line: change.range.end.line, character: change.range.end.character },
      },
      text: change.text,
    })),
    source: 'typed',
  };
}

/** Build a doc.save payload from a VS Code TextDocument. */
export function transformDocSave(
  document: vscode.TextDocument,
  workspace: WorkspaceLike,
  contentHash: string,
): DocSavePayload {
  return {
    path: workspace.asRelativePath(document.uri),
    sha256: contentHash,
  };
}

/** Build a doc.close payload from a VS Code TextDocument. */
export function transformDocClose(
  document: vscode.TextDocument,
  workspace: WorkspaceLike,
): DocClosePayload {
  return {
    path: workspace.asRelativePath(document.uri),
  };
}

/**
 * Build a selection.change payload from a VS Code TextEditorSelectionChangeEvent.
 * Uses the FIRST selection. Cursor-only = start === end → was_selection: false.
 */
export function transformSelectionChange(
  event: vscode.TextEditorSelectionChangeEvent,
  workspace: WorkspaceLike,
): SelectionChangePayload {
  const sel = event.selections[0];
  // sel is always defined (VS Code guarantees at least one selection)
  const range = sel
    ? {
        start: { line: sel.start.line, character: sel.start.character },
        end: { line: sel.end.line, character: sel.end.character },
      }
    : { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };

  const was_selection = sel ? !sel.isEmpty : false;

  return {
    path: workspace.asRelativePath(event.textEditor.document.uri),
    range,
    was_selection,
  };
}

/**
 * Build a focus.change payload.
 * Caller is responsible for only invoking on actual transitions.
 */
export function transformFocusChange(
  windowState: vscode.WindowState,
  _previousFocused: boolean,
): FocusChangePayload {
  return {
    gained: windowState.focused,
  };
}
