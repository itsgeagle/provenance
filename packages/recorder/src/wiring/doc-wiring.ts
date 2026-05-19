/**
 * Doc wiring — registers VS Code subscriptions for doc.*, selection.change, focus.change.
 * Logic lives in doc-events.ts (pure); this file is the seam between VS Code and that logic.
 *
 * PRD §4.2: record doc.open/change/save/close for ANY file in the workspace.
 * PRD §4.5: maintain ExpectedContent ONLY for files in files_under_review.
 */

import * as vscode from 'vscode';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type {
  DocOpenPayload,
  DocChangePayload,
  DocSavePayload,
  DocClosePayload,
  SelectionChangePayload,
  FocusChangePayload,
} from '@provenance/log-core';
import {
  transformDocOpen,
  transformDocChange,
  transformDocSave,
  transformDocClose,
  transformSelectionChange,
  transformFocusChange,
  type WorkspaceLike,
} from '../events/doc-events.js';
import { ExpectedContentRegistry } from '../state/expected-content-registry.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DocWiringDeps = {
  workspace: WorkspaceLike;
  emitDocOpen: (data: DocOpenPayload) => void;
  emitDocChange: (data: DocChangePayload) => void;
  emitDocSave: (data: DocSavePayload) => void;
  emitDocClose: (data: DocClosePayload) => void;
  emitSelectionChange: (data: SelectionChangePayload) => void;
  emitFocusChange: (data: FocusChangePayload) => void;
  /** Relative paths from the .cs61a manifest. */
  filesUnderReview: readonly string[];
  /** Registry for expected-content model. */
  expectedContent: ExpectedContentRegistry;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeHash(content: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(content)));
}

// ---------------------------------------------------------------------------
// startDocWiring
// ---------------------------------------------------------------------------

/**
 * Register all doc-event subscriptions and return a Disposable that tears them all down.
 */
export function startDocWiring(deps: DocWiringDeps): vscode.Disposable {
  const {
    workspace,
    emitDocOpen,
    emitDocChange,
    emitDocSave,
    emitDocClose,
    emitSelectionChange,
    emitFocusChange,
    expectedContent,
  } = deps;

  // Track previous focus state for transition detection
  let prevFocused = vscode.window.state.focused;

  // -------------------------------------------------------------------------
  // doc.open
  // -------------------------------------------------------------------------
  const openSub = vscode.workspace.onDidOpenTextDocument((document) => {
    const relativePath = workspace.asRelativePath(document.uri);
    let hash: string;

    if (expectedContent.isWatched(relativePath)) {
      // Create (or restore) expected-content state for this file
      const ec = expectedContent.getOrCreate(relativePath, document.getText());
      hash = ec.hash;
    } else {
      hash = computeHash(document.getText());
    }

    emitDocOpen(transformDocOpen(document, workspace, hash));
  });

  // -------------------------------------------------------------------------
  // doc.change
  // -------------------------------------------------------------------------
  const changeSub = vscode.workspace.onDidChangeTextDocument((event) => {
    const relativePath = workspace.asRelativePath(event.document.uri);

    // Apply deltas to expected content if watched
    if (expectedContent.isWatched(relativePath)) {
      const ec = expectedContent.get(relativePath);
      if (ec !== undefined) {
        ec.applyDeltas(
          event.contentChanges.map((c) => ({
            range: {
              start: { line: c.range.start.line, character: c.range.start.character },
              end: { line: c.range.end.line, character: c.range.end.character },
            },
            text: c.text,
          })),
        );
      }
    }

    emitDocChange(transformDocChange(event, workspace));
  });

  // -------------------------------------------------------------------------
  // doc.save
  // -------------------------------------------------------------------------
  const saveSub = vscode.workspace.onDidSaveTextDocument((document) => {
    const relativePath = workspace.asRelativePath(document.uri);
    let hash: string;

    if (expectedContent.isWatched(relativePath)) {
      const ec = expectedContent.get(relativePath);
      // For Phase 5, we trust expected content == on-disk content.
      // Phase 7 will compare against disk for fs.external_change.
      hash = ec !== undefined ? ec.hash : computeHash(document.getText());
    } else {
      hash = computeHash(document.getText());
    }

    emitDocSave(transformDocSave(document, workspace, hash));
  });

  // -------------------------------------------------------------------------
  // doc.close
  // -------------------------------------------------------------------------
  const closeSub = vscode.workspace.onDidCloseTextDocument((document) => {
    // CLAUDE.md: do not delete registry entry on close; close+reopen is common.
    emitDocClose(transformDocClose(document, workspace));
  });

  // -------------------------------------------------------------------------
  // selection.change
  // -------------------------------------------------------------------------
  const selectionSub = vscode.window.onDidChangeTextEditorSelection((event) => {
    emitSelectionChange(transformSelectionChange(event, workspace));
  });

  // -------------------------------------------------------------------------
  // focus.change (window state transitions only)
  // -------------------------------------------------------------------------
  const focusSub = vscode.window.onDidChangeWindowState((state) => {
    if (state.focused !== prevFocused) {
      emitFocusChange(transformFocusChange(state, prevFocused));
      prevFocused = state.focused;
    }
  });

  return {
    dispose() {
      openSub.dispose();
      changeSub.dispose();
      saveSub.dispose();
      closeSub.dispose();
      selectionSub.dispose();
      focusSub.dispose();
    },
  };
}
