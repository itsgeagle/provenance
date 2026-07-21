/**
 * Tests for startHeartbeat.
 *
 * Uses vi.useFakeTimers() to control time without real delays.
 * Stub all four subscription registrars to capture handlers and return mock disposables.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { startHeartbeat, HeartbeatPayload, ResumedPayload, HeartbeatDeps } from './heartbeat.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDisposable() {
  return { dispose: vi.fn() };
}

function makeTestDeps(overrides?: {
  windowFocused?: boolean;
  activeFile?: string | null;
  intervalMs?: number;
}) {
  const windowState = { focused: overrides?.windowFocused ?? true };
  const activeFile = overrides?.activeFile ?? 'hw.py';
  let now = 0;
  // Wall clock is tracked independently of the monotonic `now` so tests can
  // simulate a suspend: the interval timer only fires once it's scheduled to
  // (monotonic-ish, driven by vi.advanceTimersByTime), but the wall clock can
  // have jumped much further ahead in the meantime.
  let wallNow = 0;

  const getNow = () => now;
  const advanceTime = (ms: number) => {
    now += ms;
  };

  const getWallMs = () => wallNow;
  const advanceWall = (ms: number) => {
    wallNow += ms;
  };
  /** Advance both clocks together by the same amount — the normal, no-sleep case. */
  const advanceBoth = (ms: number) => {
    advanceTime(ms);
    advanceWall(ms);
  };

  const emitted: HeartbeatPayload[] = [];
  const emit = (data: HeartbeatPayload) => emitted.push(data);

  const resumedEmitted: ResumedPayload[] = [];
  const emitResumed = (data: ResumedPayload) => resumedEmitted.push(data);

  // Records emit + emitResumed calls in call order, so tests can assert that
  // session.resumed lands strictly before that tick's session.heartbeat.
  const emitOrder: Array<'resumed' | 'heartbeat'> = [];
  const emitTracked = (data: HeartbeatPayload) => {
    emitOrder.push('heartbeat');
    emit(data);
  };
  const emitResumedTracked = (data: ResumedPayload) => {
    emitOrder.push('resumed');
    emitResumed(data);
  };

  // Subscription stubs — capture the handler so tests can invoke it.
  let focusHandler: (() => void) | undefined;
  let editorHandler: (() => void) | undefined;
  let docHandler: (() => void) | undefined;

  const focusSub = makeDisposable();
  const editorSub = makeDisposable();
  const docSub = makeDisposable();

  const onDidChangeFocus = (h: () => void) => {
    focusHandler = h;
    return focusSub;
  };
  const onDidChangeActiveTextEditor = (h: () => void) => {
    editorHandler = h;
    return editorSub;
  };
  const onDidChangeTextDocument = (h: () => void) => {
    docHandler = h;
    return docSub;
  };

  const deps: HeartbeatDeps = {
    intervalMs: overrides?.intervalMs ?? 10,
    emit: emitTracked,
    emitResumed: emitResumedTracked,
    getNow,
    getWallMs,
    windowState,
    activeTextEditor: () => activeFile,
    onDidChangeFocus,
    onDidChangeActiveTextEditor,
    onDidChangeTextDocument,
  };

  return {
    deps,
    // Test controls
    advanceTime,
    advanceWall,
    advanceBoth,
    emitted,
    resumedEmitted,
    emitOrder,
    windowState,
    getFocusHandler: () => focusHandler,
    getEditorHandler: () => editorHandler,
    getDocHandler: () => docHandler,
    focusSub,
    editorSub,
    docSub,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('startHeartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits once after first interval fires with correct idle_since_ms', () => {
    const t = makeTestDeps({ intervalMs: 10 });
    // tStart = 0; lastActivityAtMs = 0

    const disposable = startHeartbeat(t.deps);

    // Advance time by 10ms in getNow so idle_since_ms reflects it.
    t.advanceTime(10);
    vi.advanceTimersByTime(10);

    expect(t.emitted).toHaveLength(1);
    expect(t.emitted[0]?.idle_since_ms).toBe(10);

    disposable.dispose();
  });

  it('focus-change handler resets activity: idle_since_ms drops', () => {
    const t = makeTestDeps({ intervalMs: 10 });

    const disposable = startHeartbeat(t.deps);

    // Advance 8ms without activity.
    t.advanceTime(8);

    // Focus change fires at t=8 — resets lastActivityAtMs to 8.
    t.getFocusHandler()?.();

    // Advance 2 more ms to hit first tick at t=10.
    t.advanceTime(2);
    vi.advanceTimersByTime(10);

    expect(t.emitted).toHaveLength(1);
    // idle_since_ms = now(10) - lastActivityAtMs(8) = 2
    expect(t.emitted[0]?.idle_since_ms).toBe(2);

    disposable.dispose();
  });

  it('text-change handler resets activity: idle_since_ms drops', () => {
    const t = makeTestDeps({ intervalMs: 10 });

    const disposable = startHeartbeat(t.deps);

    t.advanceTime(7);
    // Doc change at t=7.
    t.getDocHandler()?.();

    t.advanceTime(3);
    vi.advanceTimersByTime(10);

    expect(t.emitted).toHaveLength(1);
    // idle_since_ms = 10 - 7 = 3
    expect(t.emitted[0]?.idle_since_ms).toBe(3);

    disposable.dispose();
  });

  it('active-editor-change handler resets activity', () => {
    const t = makeTestDeps({ intervalMs: 10 });

    const disposable = startHeartbeat(t.deps);

    t.advanceTime(5);
    t.getEditorHandler()?.();

    t.advanceTime(5);
    vi.advanceTimersByTime(10);

    expect(t.emitted).toHaveLength(1);
    expect(t.emitted[0]?.idle_since_ms).toBe(5);

    disposable.dispose();
  });

  it('dispose() clears the interval so no further emits fire', () => {
    const t = makeTestDeps({ intervalMs: 10 });

    const disposable = startHeartbeat(t.deps);
    disposable.dispose();

    // Advance well past the interval.
    t.advanceTime(100);
    vi.advanceTimersByTime(100);

    expect(t.emitted).toHaveLength(0);
  });

  it('dispose() calls dispose on all three subscription disposables', () => {
    const t = makeTestDeps({ intervalMs: 10 });

    const disposable = startHeartbeat(t.deps);
    disposable.dispose();

    expect(t.focusSub.dispose).toHaveBeenCalledOnce();
    expect(t.editorSub.dispose).toHaveBeenCalledOnce();
    expect(t.docSub.dispose).toHaveBeenCalledOnce();
  });

  it('focused state reflects windowState.focused value at tick time', () => {
    const t = makeTestDeps({ intervalMs: 10, windowFocused: false });

    const disposable = startHeartbeat(t.deps);

    t.advanceTime(10);
    vi.advanceTimersByTime(10);

    expect(t.emitted[0]?.focused).toBe(false);

    // Change focus state and fire another tick.
    t.windowState.focused = true;
    t.advanceTime(10);
    vi.advanceTimersByTime(10);

    expect(t.emitted[1]?.focused).toBe(true);

    disposable.dispose();
  });

  it('active_file reflects activeTextEditor() value at tick time', () => {
    let currentFile: string | null = 'hw.py';
    const t = makeTestDeps({ intervalMs: 10 });
    t.deps.activeTextEditor = () => currentFile;

    const disposable = startHeartbeat(t.deps);

    t.advanceTime(10);
    vi.advanceTimersByTime(10);
    expect(t.emitted[0]?.active_file).toBe('hw.py');

    currentFile = null;
    t.advanceTime(10);
    vi.advanceTimersByTime(10);
    expect(t.emitted[1]?.active_file).toBeNull();

    disposable.dispose();
  });

  describe('session.resumed detection', () => {
    it('does not emit resumed on the first tick (no previous tick to compare)', () => {
      const t = makeTestDeps({ intervalMs: 10 });

      const disposable = startHeartbeat(t.deps);

      t.advanceBoth(10);
      vi.advanceTimersByTime(10);

      expect(t.emitted).toHaveLength(1);
      expect(t.resumedEmitted).toHaveLength(0);

      disposable.dispose();
    });

    it('does not emit resumed when the wall gap matches the expected interval', () => {
      const t = makeTestDeps({ intervalMs: 10 });

      const disposable = startHeartbeat(t.deps);

      // First tick — establishes the baseline, no comparison yet.
      t.advanceBoth(10);
      vi.advanceTimersByTime(10);
      // Second tick — normal cadence, gap == intervalMs.
      t.advanceBoth(10);
      vi.advanceTimersByTime(10);

      expect(t.emitted).toHaveLength(2);
      expect(t.resumedEmitted).toHaveLength(0);

      disposable.dispose();
    });

    it('does not emit resumed just under the 2x-interval threshold', () => {
      const t = makeTestDeps({ intervalMs: 10 });

      const disposable = startHeartbeat(t.deps);

      t.advanceBoth(10);
      vi.advanceTimersByTime(10);

      // Wall jumps by 19ms (< 2 * 10 = 20) even though the timer only fires
      // on schedule at +10ms — simulates a small, unremarkable wall drift.
      t.advanceTime(10);
      t.advanceWall(19);
      vi.advanceTimersByTime(10);

      expect(t.resumedEmitted).toHaveLength(0);

      disposable.dispose();
    });

    it('emits session.resumed when the wall gap is >= 2x the interval (simulated sleep)', () => {
      const t = makeTestDeps({ intervalMs: 10 });

      const disposable = startHeartbeat(t.deps);

      // First tick establishes the baseline.
      t.advanceBoth(10);
      vi.advanceTimersByTime(10);

      // The machine sleeps: the interval timer is suspended by the OS and only
      // fires once more, on schedule, after waking — but the wall clock jumped
      // far ahead of the monotonic clock while suspended.
      t.advanceTime(10); // monotonic only advances by one tick
      t.advanceWall(5_000); // wall clock reflects the full sleep duration
      vi.advanceTimersByTime(10);

      expect(t.resumedEmitted).toHaveLength(1);
      expect(t.resumedEmitted[0]).toEqual({ gap_ms: 5_000, expected_interval_ms: 10 });

      disposable.dispose();
    });

    it('emits session.resumed before that tick session.heartbeat (seq ordering)', () => {
      const t = makeTestDeps({ intervalMs: 10 });

      const disposable = startHeartbeat(t.deps);

      t.advanceBoth(10);
      vi.advanceTimersByTime(10);
      t.emitOrder.length = 0; // clear the first tick's (heartbeat-only) entry

      t.advanceTime(10);
      t.advanceWall(5_000);
      vi.advanceTimersByTime(10);

      expect(t.emitOrder).toEqual(['resumed', 'heartbeat']);

      disposable.dispose();
    });

    it('does not emit resumed on a negative gap (wall clock stepped backwards)', () => {
      const t = makeTestDeps({ intervalMs: 10 });

      const disposable = startHeartbeat(t.deps);

      t.advanceBoth(10);
      vi.advanceTimersByTime(10);

      // NTP correction steps the wall clock backwards between ticks.
      t.advanceTime(10);
      t.advanceWall(-1_000);
      vi.advanceTimersByTime(10);

      expect(t.resumedEmitted).toHaveLength(0);
      expect(t.emitted).toHaveLength(2);

      disposable.dispose();
    });
  });
});
