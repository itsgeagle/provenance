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
  FsExternalChangePayload,
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
import { compareSavedContent } from '../events/external-change-detector.js';
import type { ExplanationTagger } from '../events/explanation-tags.js';

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
  emitFsExternalChange: (data: FsExternalChangePayload) => void;
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
  /**
   * Read the on-disk content of a file after save. Path is relative to the workspace.
   * Used by Phase 7 external-change detection on the doc.save path.
   * In production: reads via node:fs/promises. In tests: stub.
   */
  readFile: (relativePath: string) => Promise<string>;
  /** Optional explanation tagger (Phase 8 will hook formatters/git into it). */
  explanationTagger?: ExplanationTagger;
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

export type DocWiringHandle = vscode.Disposable & {
  /** Returns the monotonic time of the last doc.change for a relative path, or -Infinity. */
  getLastDocChangeAt: (relativePath: string) => number;
};

/**
 * Register all doc-event subscriptions and return a DocWiringHandle that tears them all down.
 */
export function startDocWiring(deps: DocWiringDeps): DocWiringHandle {
  const {
    workspace,
    emitDocOpen,
    emitDocChange,
    emitDocSave,
    emitDocClose,
    emitPaste,
    emitSelectionChange,
    emitFocusChange,
    emitFsExternalChange,
    expectedContent,
    pasteIntercept,
    largeInsertCounter,
    getNow,
    readFile,
    explanationTagger,
  } = deps;

  // Track the most recent doc.change time per relative path (for fs-watcher tolerance).
  const lastDocChangeAt = new Map<string, number>();

  // Track previous focus state for transition detection
  let prevFocused = vscode.window.state.focused;

  // -------------------------------------------------------------------------
  // Recordability filter (PRD §4.1, §4.2)
  //
  // The recorder MUST NOT record activity outside the assignment workspace.
  // This guard is the single source of truth for "is this document inside
  // the workspace and is it a real on-disk file?" It is applied at the top
  // of every live subscription handler (open/change/save/close/selection).
  //
  // Two checks:
  //   1. scheme === 'file'  — excludes 'vscode-userdata', 'output', 'git',
  //      'untitled', and any other virtual scheme.
  //   2. asRelativePath(uri) !== uri.fsPath  — VS Code's asRelativePath
  //      returns the absolute fsPath verbatim when the file is OUTSIDE the
  //      workspace folder. A successful relative-path conversion means the
  //      file is inside the workspace.
  //
  // The startup catch-up loop at the bottom of this function applies the
  // same filter inline; the helper here covers live events.
  // -------------------------------------------------------------------------
  function isRecordable(uri: { fsPath: string; scheme: string }): boolean {
    if (uri.scheme !== 'file') return false;
    const rel = workspace.asRelativePath(uri as import('vscode').Uri);
    return rel !== uri.fsPath;
  }

  // -------------------------------------------------------------------------
  // doc.open
  // -------------------------------------------------------------------------
  // Track documents we've already emitted doc.open for. VS Code should not
  // re-fire onDidOpenTextDocument for documents already open, but we add a
  // defensive guard anyway: if a future VS Code API change or version causes
  // a re-fire for an already-seen document, this Set prevents a double-emit.
  const seenDocs = new Set<string>();

  /**
   * Emit a doc.open event for `document`.
   * Reads the document text ONCE (via getText()) and passes it to both the
   * expected-content registry (for hash computation) and transformDocOpen
   * (for content inlining). This avoids a second getText() call.
   */
  function emitDocOpenForDocument(document: {
    uri: { fsPath: string; scheme: string };
    lineCount: number;
    getText(): string;
  }): void {
    const relativePath = workspace.asRelativePath(document.uri as import('vscode').Uri);

    // Defensive de-dup: skip if we've already emitted doc.open for this path.
    if (seenDocs.has(relativePath)) {
      return;
    }
    seenDocs.add(relativePath);

    const text = document.getText();
    let hash: string;

    if (expectedContent.isWatched(relativePath)) {
      // Create (or restore) expected-content state for this file
      const ec = expectedContent.getOrCreate(relativePath, text);
      hash = ec.hash;
    } else {
      hash = computeHash(text);
    }

    emitDocOpen(transformDocOpen(document as import('vscode').TextDocument, workspace, hash, text));
  }

  const openSub = vscode.workspace.onDidOpenTextDocument((document) => {
    if (!isRecordable(document.uri)) return;
    emitDocOpenForDocument(document);
  });

  // -------------------------------------------------------------------------
  // doc.change — integrates paste detection (PRD §4.3)
  // -------------------------------------------------------------------------
  const changeSub = vscode.workspace.onDidChangeTextDocument((event) => {
    if (!isRecordable(event.document.uri)) return;
    const relativePath = workspace.asRelativePath(event.document.uri);

    // Track last doc.change time for this path BEFORE checking contentChanges length.
    // Empty-delta events (dirty-flag toggles, encoding/EOL changes) still represent a
    // document touch and should update the fs-watcher tolerance clock. We skip emitting
    // doc.change for non-content changes, but we do track the timestamp.
    lastDocChangeAt.set(relativePath, getNow());

    // VS Code fires onDidChangeTextDocument for non-content reasons too
    // (dirty-flag toggles, encoding/EOL changes). These events have no
    // contentChanges and are noise to the analyzer — drop them early.
    if (event.contentChanges.length === 0) {
      return;
    }

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

      // Two emit paths:
      //
      // (a) Single delta with empty range — classical paste shape. Emit a
      //     `paste` event; analyzer reconstructs the file by inserting the
      //     pasted text at the recorded range.
      //
      // (b) Anything else (multi-delta WorkspaceEdit, large replacement of
      //     existing content) — emit `doc.change` with source='paste_likely'
      //     so the analyzer can apply the deltas faithfully (preserves
      //     reconstruction). The `source` field marks it as suspicious for
      //     downstream heuristics. We cannot route these through `paste`
      //     because PastePayload carries a single range/text, while the
      //     event in question may span multiple disjoint ranges that
      //     applyPaste cannot reproduce.
      const isSinglePasteShaped =
        deltas.length === 1 &&
        deltas[0]!.range.start.line === deltas[0]!.range.end.line &&
        deltas[0]!.range.start.character === deltas[0]!.range.end.character;

      if (isSinglePasteShaped) {
        const delta = deltas[0]!;
        const fields = buildPastePayload(delta.text);
        const pastePayload = transformPaste(relativePath, delta.range, fields);
        emitPaste(pastePayload);
      } else {
        // Bulk insertion that isn't a clean single-range paste: emit as
        // doc.change with paste_likely source so reconstruction stays
        // faithful and heuristics can still see the signal.
        const payload = transformDocChange(event, workspace);
        payload.source = 'paste_likely';
        emitDocChange(payload);
      }
    } else {
      // typed path — emit doc.change as before
      emitDocChange(transformDocChange(event, workspace));
    }
  });

  // -------------------------------------------------------------------------
  // doc.save — Phase 7: compare on-disk content against expected for watched files.
  // -------------------------------------------------------------------------
  const saveSub = vscode.workspace.onDidSaveTextDocument((document) => {
    if (!isRecordable(document.uri)) return;
    const relativePath = workspace.asRelativePath(document.uri);

    if (expectedContent.isWatched(relativePath)) {
      const ec = expectedContent.get(relativePath);
      if (ec !== undefined) {
        // Read the actual on-disk content to compare with expected.
        // We must use readFile rather than doc.getText() because the VS Code
        // buffer may differ from what a concurrent tool wrote (PRD §4.5).
        readFile(relativePath).then(
          (onDiskContent) => {
            const result = compareSavedContent(ec, onDiskContent);

            if (result.kind === 'external_change') {
              // Emit fs.external_change FIRST, then reset, then emit doc.save.
              // Order matters: doc.save's hash represents the post-reset state.
              const explanation = explanationTagger?.consume();
              emitFsExternalChange({
                path: relativePath,
                old_hash: result.old_hash,
                new_hash: result.new_hash,
                diff_size: result.diff_size,
                ...(explanation !== undefined ? { explanation } : {}),
              });
              // Reset expected content to the on-disk reality before emitting doc.save.
              ec.reset(onDiskContent);
            }

            // Always emit doc.save with the actual on-disk hash.
            const saveHash = result.kind === 'clean_save' ? result.new_hash : result.new_hash;
            emitDocSave(transformDocSave(document, workspace, saveHash));
          },
          (_err) => {
            // Fallback: use expected hash if we can't read the file.
            emitDocSave(transformDocSave(document, workspace, ec.hash));
          },
        );
        return; // async path; doc.save emitted inside the promise handler
      }
    }

    // Unwatched file or no expected-content entry: use doc.getText() hash.
    const hash = computeHash(document.getText());
    emitDocSave(transformDocSave(document, workspace, hash));
  });

  // -------------------------------------------------------------------------
  // doc.close
  // -------------------------------------------------------------------------
  const closeSub = vscode.workspace.onDidCloseTextDocument((document) => {
    if (!isRecordable(document.uri)) return;
    // CLAUDE.md: do not delete registry entry on close; close+reopen is common.
    emitDocClose(transformDocClose(document, workspace));
  });

  // -------------------------------------------------------------------------
  // selection.change
  // -------------------------------------------------------------------------
  const selectionSub = vscode.window.onDidChangeTextEditorSelection((event) => {
    if (!isRecordable(event.textEditor.document.uri)) return;
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

  // -------------------------------------------------------------------------
  // Issue A fix: emit synthetic doc.open for documents already open at
  // activation time.
  //
  // VS Code's onDidOpenTextDocument fires only for documents that open AFTER
  // the extension activates. Any file that was already open when the extension
  // started (e.g., the student had hw.py open before hitting "Start Session")
  // never triggers the subscription. We cover the gap by iterating
  // vscode.workspace.textDocuments synchronously.
  //
  // Filter: only `file`-scheme URIs whose relative path differs from the
  // absolute fsPath (i.e., the document is inside the workspace folder).
  // This excludes untitled buffers, git-extension overlays, output panels,
  // and any virtual-document schemes that should not appear in the log.
  //
  // Ordering: subscriptions are wired before this block executes, so any
  // document that opens between subscription-registration and here would be
  // handled by the live `openSub`. The `seenDocs` Set in
  // `emitDocOpenForDocument` prevents double-emits for such a race.
  // -------------------------------------------------------------------------
  for (const doc of vscode.workspace.textDocuments) {
    if (!isRecordable(doc.uri)) continue;
    emitDocOpenForDocument(doc);
  }

  return {
    dispose() {
      openSub.dispose();
      changeSub.dispose();
      saveSub.dispose();
      closeSub.dispose();
      selectionSub.dispose();
      focusSub.dispose();
    },
    getLastDocChangeAt(relativePath: string): number {
      return lastDocChangeAt.get(relativePath) ?? -Infinity;
    },
  };
}
