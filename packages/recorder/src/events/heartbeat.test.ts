/**
 * Tests for startHeartbeat.
 *
 * Uses vi.useFakeTimers() to control time without real delays.
 * Stub all four subscription registrars to capture handlers and return mock disposables.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { startHeartbeat, HeartbeatPayload, HeartbeatDeps } from './heartbeat.js';

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

  const getNow = () => now;
  const advanceTime = (ms: number) => {
    now += ms;
  };

  const emitted: HeartbeatPayload[] = [];
  const emit = (data: HeartbeatPayload) => emitted.push(data);

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
    emit,
    getNow,
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
    emitted,
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
});
