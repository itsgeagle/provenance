/**
 * Doc wiring — registers VS Code subscriptions for doc.*, selection.change, focus.change.
 * Logic lives in doc-events.ts (pure); this file is the seam between VS Code and that logic.
 *
 * PRD §4.2: record doc.open/change/save/close for ANY file in the workspace.
 * PRD §4.3: paste detection (three-signal). Signal 1 (classifier) and signal 2
 *           (command intercept) are integrated here; signal 3 (reconciler) runs
 *           in extension.ts independently.
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
  PastePayload,
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
  transformPaste,
  type WorkspaceLike,
} from '../events/doc-events.js';
import { classifyChange } from '../events/paste-classifier.js';
import { buildPastePayload } from '../events/paste-payload.js';
import { ExpectedContentRegistry } from '../state/expected-content-registry.js';
import type { PasteIntercept } from './paste-command-intercept.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal counter shared between doc-wiring and the paste reconciler. */
export type LargeInsertCounter = {
  increment(): void;
  count(): number;
};

export type DocWiringDeps = {
  workspace: WorkspaceLike;
  emitDocOpen: (data: DocOpenPayload) => void;
  emitDocChange: (data: DocChangePayload) => void;
  emitDocSave: (data: DocSavePayload) => void;
  emitDocClose: (data: DocClosePayload) => void;
  emitPaste: (data: PastePayload) => void;
  emitSelectionChange: (data: SelectionChangePayload) => void;
  emitFocusChange: (data: FocusChangePayload) => void;
  /** Relative paths from the .cs61a manifest. */
  filesUnderReview: readonly string[];
  /** Registry for expected-content model. */
  expectedContent: ExpectedContentRegistry;
  /** Signal 2: command-intercept handle. Null if not available (tests can omit). */
  pasteIntercept: PasteIntercept | null;
  /** Counter shared with the paste reconciler (signal 3). */
  largeInsertCounter: LargeInsertCounter;
  /** Clock.now() for comparing paste-intercept timestamps. */
  getNow: () => number;
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
    emitPaste,
    emitSelectionChange,
    emitFocusChange,
    expectedContent,
    pasteIntercept,
    largeInsertCounter,
    getNow,
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
  // doc.change — integrates paste detection (PRD §4.3)
  // -------------------------------------------------------------------------
  const changeSub = vscode.workspace.onDidChangeTextDocument((event) => {
    const relativePath = workspace.asRelativePath(event.document.uri);

    // Build log-core delta representation
    const deltas = event.contentChanges.map((c) => ({
      range: {
        start: { line: c.range.start.line, character: c.range.start.character },
        end: { line: c.range.end.line, character: c.range.end.character },
      },
      text: c.text,
    }));

    // Apply deltas to expected content if watched (unchanged from Phase 5)
    if (expectedContent.isWatched(relativePath)) {
      const ec = expectedContent.get(relativePath);
      if (ec !== undefined) {
        ec.applyDeltas(deltas);
      }
    }

    // --- Signal 1: size-based classification ---
    const classification = classifyChange(deltas);

    if (classification === 'paste_likely') {
      // Increment large-insert counter for signal 3 (reconciler)
      largeInsertCounter.increment();

      // --- Signal 2: check if a paste command was intercepted just before this ---
      const now = getNow();
      const isConfirmed = pasteIntercept !== null && pasteIntercept.consumeIfPasteExpected(now);
      // Note: isConfirmed vs paste_likely distinction is not in the PRD paste payload;
      // both produce a 'paste' event. The reconciler (signal 3) handles discrepancy tracking.
      void isConfirmed; // intentionally unused in v1 per PRD analysis in task spec

      // Build paste payload from the single delta's text
      const delta = deltas[0]!;
      const fields = buildPastePayload(delta.text);
      const pastePayload = transformPaste(relativePath, delta.range, fields);

      emitPaste(pastePayload);
    } else {
      // typed path — emit doc.change as before
      emitDocChange(transformDocChange(event, workspace));
    }
  });

  // -------------------------------------------------------------------------
  // doc.save
  // -------------------------------------------------------------------------
  const saveSub = vscode.workspace.onDidSaveTextDocument((document) => {
    const relativePath = workspace.asRelativePath(document.uri);
    let hash: string;

    if (expectedContent.isWatched(relativePath)) {
      const ec = expectedContent.get(relativePath);
      // For Phase 5/6, we trust expected content == on-disk content.
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
