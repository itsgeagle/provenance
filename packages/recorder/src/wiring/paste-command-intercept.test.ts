import { describe, expect, it, vi } from 'vitest';
import { startPasteIntercept, PASTE_INTERCEPT_COMMAND_ID } from './paste-command-intercept.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDisposable() {
  let disposed = false;
  return {
    dispose: () => {
      disposed = true;
    },
    isDisposed: () => disposed,
  };
}

function makeDeps(nowMs = 1000) {
  let currentTime = nowMs;
  const registeredCommands = new Map<string, () => Thenable<unknown>>();
  const executedCommands: string[] = [];
  const disposable = makeDisposable();

  return {
    deps: {
      registerCommand: (id: string, handler: () => Thenable<unknown>) => {
        registeredCommands.set(id, handler);
        return disposable;
      },
      executeCommand: (id: string, ..._args: unknown[]) => {
        executedCommands.push(id);
        return Promise.resolve(undefined);
      },
      getNow: () => currentTime,
    },
    registeredCommands,
    executedCommands,
    disposable,
    setNow: (ms: number) => {
      currentTime = ms;
    },
    advanceTime: (ms: number) => {
      currentTime += ms;
    },
    /** Invoke the registered intercept command. */
    triggerCommand: () => {
      const handler = registeredCommands.get(PASTE_INTERCEPT_COMMAND_ID);
      if (handler === undefined) throw new Error('command not registered');
      return handler();
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('startPasteIntercept', () => {
  it('registers the provenance.internal.pasteIntercept command', () => {
    const { deps, registeredCommands } = makeDeps();
    startPasteIntercept(deps);
    expect(registeredCommands.has(PASTE_INTERCEPT_COMMAND_ID)).toBe(true);
  });

  it('interceptCount starts at 0', () => {
    const { deps } = makeDeps();
    const intercept = startPasteIntercept(deps);
    expect(intercept.interceptCount).toBe(0);
  });

  it('invoking the command increments interceptCount', async () => {
    const { deps, triggerCommand } = makeDeps();
    const intercept = startPasteIntercept(deps);
    await triggerCommand();
    expect(intercept.interceptCount).toBe(1);
    await triggerCommand();
    expect(intercept.interceptCount).toBe(2);
  });

  it('invoking the command forwards to editor.action.clipboardPasteAction', async () => {
    const { deps, executedCommands, triggerCommand } = makeDeps();
    startPasteIntercept(deps);
    await triggerCommand();
    expect(executedCommands).toContain('editor.action.clipboardPasteAction');
  });

  it('consumeIfPasteExpected returns false before any command invocation', () => {
    const { deps } = makeDeps(1000);
    const intercept = startPasteIntercept(deps);
    expect(intercept.consumeIfPasteExpected(1000)).toBe(false);
  });

  it('consumeIfPasteExpected returns true within default 50ms window', async () => {
    const { deps, triggerCommand } = makeDeps(1000);
    const intercept = startPasteIntercept(deps);
    await triggerCommand(); // sets pasteExpectedAtMs = 1000
    expect(intercept.consumeIfPasteExpected(1040)).toBe(true); // 40ms later — within window
  });

  it('consumeIfPasteExpected returns true at exactly withinMs', async () => {
    const { deps, triggerCommand } = makeDeps(1000);
    const intercept = startPasteIntercept(deps);
    await triggerCommand();
    expect(intercept.consumeIfPasteExpected(1050)).toBe(true); // exactly 50ms
  });

  it('consumeIfPasteExpected returns false when window has expired', async () => {
    const { deps, triggerCommand } = makeDeps(1000);
    const intercept = startPasteIntercept(deps);
    await triggerCommand();
    expect(intercept.consumeIfPasteExpected(1051)).toBe(false); // 51ms — expired
  });

  it('consumeIfPasteExpected consumes the flag (second call returns false)', async () => {
    const { deps, triggerCommand } = makeDeps(1000);
    const intercept = startPasteIntercept(deps);
    await triggerCommand();
    expect(intercept.consumeIfPasteExpected(1020)).toBe(true); // consumes
    expect(intercept.consumeIfPasteExpected(1025)).toBe(false); // already consumed
  });

  it('custom withinMs window is respected', async () => {
    const { deps, triggerCommand, setNow } = makeDeps(1000);
    const intercept = startPasteIntercept(deps);

    // Invoke at t=1000; then check at t=1200 with window=100 → 200ms elapsed > window → false
    await triggerCommand(); // pasteExpectedAtMs = 1000
    expect(intercept.consumeIfPasteExpected(1200, 100)).toBe(false);

    // Invoke again at t=2000; check at t=2050 with window=100 → 50ms elapsed ≤ window → true
    setNow(2000);
    await triggerCommand(); // pasteExpectedAtMs = 2000
    expect(intercept.consumeIfPasteExpected(2050, 100)).toBe(true);
  });

  it('disposable from deps is returned as intercept.disposable', () => {
    const { deps, disposable } = makeDeps();
    const intercept = startPasteIntercept(deps);
    // The returned disposable should be the one the registerCommand produced
    intercept.disposable.dispose();
    expect(disposable.isDisposed()).toBe(true);
  });

  it('vi.fn() version: calls registerCommand exactly once', () => {
    const registerCommand = vi.fn(() => ({ dispose: vi.fn() }));
    const executeCommand = vi.fn(() => Promise.resolve(undefined));
    startPasteIntercept({ registerCommand, executeCommand, getNow: () => 0 });
    expect(registerCommand).toHaveBeenCalledOnce();
    expect(registerCommand).toHaveBeenCalledWith(PASTE_INTERCEPT_COMMAND_ID, expect.any(Function));
  });
});
