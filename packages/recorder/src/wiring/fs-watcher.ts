/**
 * fs-watcher.ts — FileSystemWatcher for files_under_review.
 *
 * Emits fs.external_change when an on-disk modification happens without a
 * recent corresponding doc.change. This is the "file edited while VS Code
 * unfocused" path (PRD §4.5).
 *
 * Design notes:
 * - Each file in filesUnderReview gets its own FileSystemWatcher created via
 *   vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, path)).
 * - On onDidChange: if the change happened within recentDocChangeToleranceMs of
 *   the last doc.change for that file, we skip it — VS Code-mediated saves
 *   already captured in doc.change. Only truly external changes are reported.
 * - We compare the new on-disk hash against registry.get(path)?.hash. If the
 *   file isn't in the registry (was never opened), we skip — there's no baseline.
 * - After emitting, we call expected.reset(newContent) so subsequent edits
 *   chain from reality (CLAUDE.md + PRD §4.5). This is the caller's reset, done
 *   here inside the watcher because the watcher owns the full flow.
 *
 * Timing note: VS Code's FileSystemWatcher delivers onDidChange asynchronously
 * after the OS notifies it of a change. There may be a small delay between the
 * file being written and the event firing. The recentDocChangeToleranceMs guard
 * (default 250ms) is deliberately conservative to avoid double-reporting saves
 * that VS Code processes right after a doc.change.
 */

import * as vscode from 'vscode';
import type { FsExternalChangePayload } from '@provenance/log-core';
import { sha256Hex } from '@provenance/log-core';
import type { ExpectedContentRegistry } from '../state/expected-content-registry.js';
import type { ExplanationTagger } from '../events/explanation-tags.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FsExternalChangeData = FsExternalChangePayload;

export type FsWatcherDeps = {
  workspaceFolder: vscode.WorkspaceFolder;
  filesUnderReview: readonly string[];
  registry: ExpectedContentRegistry;
  emit: (data: FsExternalChangeData) => void;
  /** Returns the time of the last doc.change for path (monotonic ms), or -Infinity. */
  getLastDocChangeAt: (path: string) => number;
  getNow: () => number;
  /** Tolerance in ms. Changes within this window of a doc.change are ignored. Default 250. */
  recentDocChangeToleranceMs?: number;
  /** Read the on-disk file content (relative path within workspace). */
  readFile: (relativePath: string) => Promise<string>;
  explanationTagger?: ExplanationTagger;
};

// ---------------------------------------------------------------------------
// startFsWatcher
// ---------------------------------------------------------------------------

/**
 * Start a FileSystemWatcher for each file in filesUnderReview.
 * Returns a Disposable that disposes all watchers.
 */
export function startFsWatcher(deps: FsWatcherDeps): vscode.Disposable {
  const {
    workspaceFolder,
    filesUnderReview,
    registry,
    emit,
    getLastDocChangeAt,
    getNow,
    readFile,
    explanationTagger,
  } = deps;
  const tolerance = deps.recentDocChangeToleranceMs ?? 250;

  const watchers: vscode.Disposable[] = [];

  for (const relativePath of filesUnderReview) {
    const pattern = new vscode.RelativePattern(workspaceFolder, relativePath);
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);

    const handleChange = (_uri: vscode.Uri) => {
      // Check whether this change is too close to a recent doc.change
      // (i.e., it was VS Code-mediated and already captured).
      const lastDocChange = getLastDocChangeAt(relativePath);
      if (getNow() - lastDocChange < tolerance) {
        // VS Code-mediated save — already captured via doc.change handler.
        return;
      }

      const expected = registry.get(relativePath);
      if (expected === undefined) {
        // File was never opened in VS Code — no baseline to compare against.
        return;
      }

      // Read on-disk content asynchronously. We capture oldHash now so the
      // comparison is against the pre-read state (avoid TOCTOU with concurrent
      // doc.changes updating the expected content before we finish reading).
      const oldHash = expected.hash;

      readFile(relativePath).then(
        (onDiskContent) => {
          const newHash = sha256Hex(onDiskContent);
          if (newHash === oldHash) {
            // No real change (e.g., file touched but content identical).
            return;
          }

          const diff_size = Math.abs(onDiskContent.length - expected.content.length);
          const explanation = explanationTagger?.consume();

          const payload: FsExternalChangeData = {
            path: relativePath,
            old_hash: oldHash,
            new_hash: newHash,
            diff_size,
            ...(explanation !== undefined ? { explanation } : {}),
          };

          emit(payload);

          // Reset expected content so subsequent edits chain from reality.
          // CLAUDE.md: "The caller is responsible for calling expected.reset(onDiskContent)
          // after recording the event."
          expected.reset(onDiskContent);
        },
        (_err) => {
          // File may have been deleted or become unreadable — skip silently.
          // Phase 11 can add a proper error event here.
        },
      );
    };

    watcher.onDidChange(handleChange);
    watchers.push(watcher);
  }

  return {
    dispose() {
      for (const w of watchers) {
        w.dispose();
      }
      watchers.length = 0;
    },
  };
}
