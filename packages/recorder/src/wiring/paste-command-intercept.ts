/**
 * Paste command intercept — signal 2 of three-signal paste detection (PRD §4.3).
 *
 * PRD §4.3: "Register a command handler that wraps the default
 * editor.action.clipboardPasteAction and emits a paste marker immediately
 * before the resulting doc.change fires."
 *
 * VS CODE LIMITATION (surfaced per CLAUDE.md):
 * VS Code does NOT allow re-registering or overriding built-in command IDs
 * (e.g. 'editor.action.clipboardPasteAction'). Calling
 * vscode.commands.registerCommand with a built-in ID will throw
 * "command already registered" in the extension host. This is a hard VS Code
 * API constraint; there is no workaround short of using an undocumented
 * internal API that could break in any VS Code update.
 *
 * v1 approach:
 * We register a SEPARATE provenance command ('provenance.internal.pasteIntercept')
 * that explicitly calls clipboardPasteAction under the hood. Course staff can
 * bind this command to Cmd+V / Ctrl+V via a workspace keybindings.json if they
 * want higher-fidelity signal 2. When invoked it:
 *   1. Sets a "paste expected" timestamp.
 *   2. Increments the interceptCount.
 *   3. Executes 'editor.action.clipboardPasteAction'.
 *
 * For sessions where the keybinding is not installed, signal 2 contributes 0
 * to the intercept count and signal 3 (reconciler) will detect the mismatch,
 * surfacing it as paste.anomaly events rather than silently misclassifying.
 *
 * The three-signal rule is preserved: signal 1 (size heuristic) + signal 3
 * (reconciler) still function regardless of whether signal 2 fires.
 */

import type * as vscode from 'vscode';

export type PasteIntercept = {
  disposable: vscode.Disposable;
  /**
   * Returns true if the most recent doc.change should be considered a
   * confirmed paste (command was invoked within `withinMs` ms of `now`).
   * Consumes the flag — a single intercept matches at most one doc.change.
   */
  consumeIfPasteExpected(now: number, withinMs?: number): boolean;
  /** How many times the paste command has been invoked since start. */
  readonly interceptCount: number;
};

export type PasteInterceptDeps = {
  registerCommand: (id: string, handler: () => Thenable<unknown>) => vscode.Disposable;
  executeCommand: (id: string, ...args: unknown[]) => Thenable<unknown>;
  getNow: () => number;
};

/** The VS Code command ID for the internal paste intercept. */
export const PASTE_INTERCEPT_COMMAND_ID = 'provenance.internal.pasteIntercept';

/**
 * Register the provenance paste-intercept command and return a PasteIntercept
 * handle that the doc-change handler can query.
 */
export function startPasteIntercept(deps: PasteInterceptDeps): PasteIntercept {
  const { registerCommand, executeCommand, getNow } = deps;

  let pasteExpectedAtMs: number | null = null;
  let _interceptCount = 0;

  const commandDisposable = registerCommand(PASTE_INTERCEPT_COMMAND_ID, async () => {
    pasteExpectedAtMs = getNow();
    _interceptCount++;
    return executeCommand('editor.action.clipboardPasteAction');
  });

  return {
    disposable: commandDisposable,

    consumeIfPasteExpected(now: number, withinMs = 50): boolean {
      if (pasteExpectedAtMs === null) {
        return false;
      }
      const elapsed = now - pasteExpectedAtMs;
      if (elapsed <= withinMs) {
        pasteExpectedAtMs = null; // consume
        return true;
      }
      // Expired — clear the stale flag so it doesn't block future checks
      pasteExpectedAtMs = null;
      return false;
    },

    get interceptCount(): number {
      return _interceptCount;
    },
  };
}
