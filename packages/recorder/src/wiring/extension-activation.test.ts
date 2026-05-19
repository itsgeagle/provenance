import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { startExtensionActivation } from './extension-activation.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeExt(id: string, version: string, isActive: boolean): vscode.Extension<unknown> {
  return {
    id,
    isActive,
    packageJSON: { version },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal mock
  } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('startExtensionActivation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not emit for already-active extensions at startup', () => {
    const emitted: unknown[] = [];
    startExtensionActivation({
      emit: (d) => emitted.push(d),
      getExtensions: () => [makeExt('ext-a', '1.0.0', true)],
      intervalMs: 1000,
    });
    vi.advanceTimersByTime(1000);
    // ext-a was active at init; no transition to emit.
    expect(emitted).toHaveLength(0);
  });

  it('emits ext.activate when an extension becomes active between polls', () => {
    const emitted: Array<{ id: string; version: string }> = [];
    let extBActive = false;
    startExtensionActivation({
      emit: (d) => emitted.push(d),
      getExtensions: () => [makeExt('ext-b', '0.5.0', extBActive)],
      intervalMs: 1000,
    });
    // ext-b was inactive at init; activate it.
    extBActive = true;
    vi.advanceTimersByTime(1000);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toEqual({ id: 'ext-b', version: '0.5.0' });
  });

  it('does not re-emit for the same extension on subsequent ticks', () => {
    const emitted: unknown[] = [];
    let extBActive = false;
    startExtensionActivation({
      emit: (d) => emitted.push(d),
      getExtensions: () => [makeExt('ext-b', '0.5.0', extBActive)],
      intervalMs: 1000,
    });
    extBActive = true;
    vi.advanceTimersByTime(1000); // first tick — emits
    vi.advanceTimersByTime(1000); // second tick — ext-b is already tracked as active
    expect(emitted).toHaveLength(1);
  });

  it('emits for multiple new activations in the same tick', () => {
    const emitted: Array<{ id: string; version: string }> = [];
    let aActive = false;
    let bActive = false;
    startExtensionActivation({
      emit: (d) => emitted.push(d),
      getExtensions: () => [makeExt('ext-a', '1.0.0', aActive), makeExt('ext-b', '2.0.0', bActive)],
      intervalMs: 1000,
    });
    aActive = true;
    bActive = true;
    vi.advanceTimersByTime(1000);
    expect(emitted).toHaveLength(2);
    expect(emitted.map((e) => e.id).sort()).toEqual(['ext-a', 'ext-b']);
  });

  it('does not emit when no extensions change', () => {
    const emitted: unknown[] = [];
    startExtensionActivation({
      emit: (d) => emitted.push(d),
      getExtensions: () => [makeExt('ext-a', '1.0.0', false)],
      intervalMs: 1000,
    });
    vi.advanceTimersByTime(5000);
    expect(emitted).toHaveLength(0);
  });

  it('dispose stops the interval', () => {
    const emitted: unknown[] = [];
    let extActive = false;
    const disposable = startExtensionActivation({
      emit: (d) => emitted.push(d),
      getExtensions: () => [makeExt('ext-c', '1.0.0', extActive)],
      intervalMs: 1000,
    });
    extActive = true;
    vi.advanceTimersByTime(1000);
    expect(emitted).toHaveLength(1);
    disposable.dispose();
    vi.advanceTimersByTime(5000);
    expect(emitted).toHaveLength(1); // no more ticks
  });
});
