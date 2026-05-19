/**
 * Heartbeat emitter.
 *
 * PRD §4.2: "session.heartbeat — Every 30s while VS Code is open — window focused (bool),
 * active file, idle since (ms)."
 *
 * CLAUDE.md: "Every `setInterval`, every watcher, every async loop has a `dispose()`."
 *
 * Design:
 * - Track last activity time (reset on focus change, active-editor change, or doc change).
 * - On each tick, read windowState.focused LIVE (not cached) and call emit().
 * - Returns a Disposable that clears the interval and all three VS Code subscriptions.
 * - .unref() the timer so it doesn't keep the process alive.
 */

import * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HeartbeatPayload = {
  focused: boolean;
  active_file: string | null;
  idle_since_ms: number;
};

export type HeartbeatDeps = {
  /** Interval between heartbeat ticks. Default: 30_000 ms. */
  intervalMs?: number;
  /** Called on each tick with the current heartbeat payload. */
  emit: (data: HeartbeatPayload) => void;
  /** Returns the current monotonic time in ms. */
  getNow: () => number;
  /**
   * VS Code window state — read LIVE each tick.
   * Pass `vscode.window.state` in production.
   */
  windowState: { focused: boolean };
  /**
   * Returns the relative path of the active editor's document, or null.
   * Called each tick.
   */
  activeTextEditor: () => string | null;
  /** Subscribe to window focus changes; returns a Disposable. */
  onDidChangeFocus: (handler: () => void) => vscode.Disposable;
  /** Subscribe to active text editor changes; returns a Disposable. */
  onDidChangeActiveTextEditor: (handler: () => void) => vscode.Disposable;
  /** Subscribe to text document changes; returns a Disposable. */
  onDidChangeTextDocument: (handler: () => void) => vscode.Disposable;
};

// ---------------------------------------------------------------------------
// startHeartbeat
// ---------------------------------------------------------------------------

/**
 * Start the heartbeat. Returns a Disposable that tears down the interval
 * and all three VS Code subscriptions.
 */
export function startHeartbeat(deps: HeartbeatDeps): vscode.Disposable {
  const {
    intervalMs = 30_000,
    emit,
    getNow,
    windowState,
    activeTextEditor,
    onDidChangeFocus,
    onDidChangeActiveTextEditor,
    onDidChangeTextDocument,
  } = deps;

  let lastActivityAtMs = getNow();

  // Activity reset handler — same for all three signals.
  function resetActivity(): void {
    lastActivityAtMs = getNow();
  }

  // Subscribe to the three VS Code events.
  const focusSub = onDidChangeFocus(resetActivity);
  const editorSub = onDidChangeActiveTextEditor(resetActivity);
  const docSub = onDidChangeTextDocument(resetActivity);

  // Periodic tick.
  const timer = setInterval(() => {
    const now = getNow();
    emit({
      // Read windowState.focused LIVE — do not cache it.
      focused: windowState.focused,
      active_file: activeTextEditor(),
      idle_since_ms: now - lastActivityAtMs,
    });
  }, intervalMs);

  // .unref() so the timer doesn't keep the VS Code Extension Host process alive.
  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  return {
    dispose(): void {
      clearInterval(timer);
      focusSub.dispose();
      editorSub.dispose();
      docSub.dispose();
    },
  };
}
