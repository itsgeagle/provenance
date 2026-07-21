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
 *
 * Suspend detection (session.resumed):
 * - When a laptop sleeps, the OS suspends the extension host — this timer doesn't fire,
 *   and nothing marks the gap. On wake, the interval resumes as if nothing happened.
 * - Each tick compares the current WALL-CLOCK time against the previous tick's wall-clock
 *   time. If that gap is >= 2x the expected interval, the process was almost certainly
 *   suspended (or the system was otherwise unable to run the timer), so a `session.resumed`
 *   marker is emitted first, immediately before that tick's `session.heartbeat` — landing
 *   its `seq` strictly between the two bounding heartbeat seqs.
 * - Deliberately wall-clock, not monotonic: on macOS `mach_continuous_time()` (Node's
 *   monotonic clock source) keeps advancing during sleep, so a monotonic comparison would
 *   never see the gap; on Linux `CLOCK_MONOTONIC` does not advance during suspend, so the
 *   two platforms would disagree. Wall-vs-expected-tick-count is the only signal that's
 *   consistent everywhere. Do not "fix" this to compare monotonic time instead.
 * - A negative gap (wall clock stepped backwards, e.g. NTP correction) is never treated as
 *   a resume — it's guarded out explicitly.
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

export type ResumedPayload = {
  gap_ms: number;
  expected_interval_ms: number;
};

export type HeartbeatDeps = {
  /** Interval between heartbeat ticks. Default: 30_000 ms. */
  intervalMs?: number;
  /** Called on each tick with the current heartbeat payload. */
  emit: (data: HeartbeatPayload) => void;
  /**
   * Called just before `emit` on a tick where the wall-clock gap since the previous
   * tick was >= 2x `intervalMs` — i.e. a probable suspend/resume.
   */
  emitResumed: (data: ResumedPayload) => void;
  /** Returns the current monotonic time in ms. */
  getNow: () => number;
  /** Returns the current wall-clock time in ms (e.g. `Date.now()`). */
  getWallMs: () => number;
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
    emitResumed,
    getNow,
    getWallMs,
    windowState,
    activeTextEditor,
    onDidChangeFocus,
    onDidChangeActiveTextEditor,
    onDidChangeTextDocument,
  } = deps;

  let lastActivityAtMs = getNow();

  // Wall-clock time at the previous tick. Undefined until the first tick fires,
  // so the very first tick never emits session.resumed (there's nothing to compare).
  let lastTickWallMs: number | undefined;

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
    const nowWall = getWallMs();

    if (lastTickWallMs !== undefined) {
      const gapMs = nowWall - lastTickWallMs;
      // Guard against a negative gap (wall clock stepped backwards, e.g. an NTP
      // correction) — never treat that as a resume.
      if (gapMs >= 0 && gapMs >= 2 * intervalMs) {
        emitResumed({ gap_ms: gapMs, expected_interval_ms: intervalMs });
      }
    }
    lastTickWallMs = nowWall;

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
