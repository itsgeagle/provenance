import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { startExtensionSnapshot } from './extension-snapshot.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeExt(id: string, version: string, isActive: boolean): vscode.Extension<unknown> {
  return {
    id,
    isActive,
    packageJSON: { version },
    extensionUri: {} as vscode.Uri,
    extensionPath: '',
    extensionKind: 1,
    exports: undefined,
    activate: () => Promise.resolve(undefined),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal mock
  } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('startExtensionSnapshot', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits immediately at startup when emitImmediately is true (default)', () => {
    const emitted: Array<{ extensions: Array<{ id: string; version: string; enabled: boolean }> }> =
      [];
    startExtensionSnapshot({
      emit: (d) => emitted.push(d),
      getExtensions: () => [makeExt('ext-a', '1.0.0', true)],
    });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.extensions).toHaveLength(1);
    expect(emitted[0]!.extensions[0]).toEqual({ id: 'ext-a', version: '1.0.0', enabled: true });
  });

  it('does not emit immediately when emitImmediately is false', () => {
    const emitted: unknown[] = [];
    startExtensionSnapshot({
      emit: (d) => emitted.push(d),
      getExtensions: () => [],
      emitImmediately: false,
    });
    expect(emitted).toHaveLength(0);
  });

  it('emits on each interval tick', () => {
    const emitted: unknown[] = [];
    startExtensionSnapshot({
      emit: (d) => emitted.push(d),
      getExtensions: () => [makeExt('ext-a', '1.0.0', true)],
      intervalMs: 1000,
      emitImmediately: false,
    });
    vi.advanceTimersByTime(1000);
    expect(emitted).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(emitted).toHaveLength(2);
    vi.advanceTimersByTime(1000);
    expect(emitted).toHaveLength(3);
  });

  it('correctly maps id, version, and enabled from extensions', () => {
    const emitted: Array<{ extensions: Array<{ id: string; version: string; enabled: boolean }> }> =
      [];
    startExtensionSnapshot({
      emit: (d) => emitted.push(d),
      getExtensions: () => [makeExt('ext-a', '2.3.4', true), makeExt('ext-b', '0.1.0', false)],
      emitImmediately: true,
    });
    expect(emitted[0]!.extensions).toEqual([
      { id: 'ext-a', version: '2.3.4', enabled: true },
      { id: 'ext-b', version: '0.1.0', enabled: false },
    ]);
  });

  it('falls back to "unknown" version when packageJSON.version is absent', () => {
    const emitted: Array<{ extensions: Array<{ id: string; version: string; enabled: boolean }> }> =
      [];
    const extNoVersion = {
      id: 'ext-no-ver',
      isActive: false,
      packageJSON: {},
    } as unknown as vscode.Extension<unknown>;
    startExtensionSnapshot({
      emit: (d) => emitted.push(d),
      getExtensions: () => [extNoVersion],
      emitImmediately: true,
    });
    expect(emitted[0]!.extensions[0]!.version).toBe('unknown');
  });

  it('disposable stops interval ticks', () => {
    const emitted: unknown[] = [];
    const disposable = startExtensionSnapshot({
      emit: (d) => emitted.push(d),
      getExtensions: () => [],
      intervalMs: 1000,
      emitImmediately: false,
    });
    vi.advanceTimersByTime(1000);
    expect(emitted).toHaveLength(1);
    disposable.dispose();
    vi.advanceTimersByTime(5000);
    // No more ticks after dispose.
    expect(emitted).toHaveLength(1);
  });
});
