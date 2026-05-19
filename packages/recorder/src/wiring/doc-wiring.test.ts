/**
 * Tests for doc-wiring.ts — verify that the VS Code subscription callbacks
 * invoke the correct emit functions with correct payloads.
 *
 * Uses vi.mock to provide a controllable vscode replacement.
 * vi.hoisted is used to define subscription capture helpers before the hoisted vi.mock call.
 */

import { describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Build controllable subscription capture helpers via vi.hoisted
// vi.mock factories are hoisted above imports; the helpers must be defined there too.
// ---------------------------------------------------------------------------

type Handler<T> = (arg: T) => void;

const {
  openSub,
  changeSub,
  saveSub,
  closeSub,
  selectionSub,
  focusSub,
  getMockWindowState,
  setMockWindowState,
} = vi.hoisted(() => {
  function makeSub<T>() {
    let captured: Handler<T> | null = null;
    return {
      get handler(): Handler<T> | null {
        return captured;
      },
      sub: (h: Handler<T>) => {
        captured = h;
        return {
          dispose: () => {
            captured = null;
          },
        };
      },
    };
  }

  const openSub = makeSub<unknown>();
  const changeSub = makeSub<unknown>();
  const saveSub = makeSub<unknown>();
  const closeSub = makeSub<unknown>();
  const selectionSub = makeSub<unknown>();
  const focusSub = makeSub<{ focused: boolean }>();

  let _state = { focused: true };

  return {
    openSub,
    changeSub,
    saveSub,
    closeSub,
    selectionSub,
    focusSub,
    getMockWindowState: () => _state,
    setMockWindowState: (s: { focused: boolean }) => {
      _state = s;
    },
  };
});

vi.mock('vscode', () => ({
  workspace: {
    onDidOpenTextDocument: openSub.sub,
    onDidChangeTextDocument: changeSub.sub,
    onDidSaveTextDocument: saveSub.sub,
    onDidCloseTextDocument: closeSub.sub,
    asRelativePath: (uri: { fsPath: string }) => uri.fsPath,
  },
  window: {
    onDidChangeTextEditorSelection: selectionSub.sub,
    onDidChangeWindowState: focusSub.sub,
    get state() {
      return getMockWindowState();
    },
  },
}));

// ---------------------------------------------------------------------------
// Imports after vi.mock
// ---------------------------------------------------------------------------

import { startDocWiring } from './doc-wiring.js';
import { ExpectedContentRegistry } from '../state/expected-content-registry.js';
import type { WorkspaceLike } from '../events/doc-events.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function fakeUri(path = 'src/foo.py') {
  return { fsPath: path };
}

function fakeDoc(options: { path?: string; lineCount?: number; text?: string } = {}) {
  return {
    uri: fakeUri(options.path ?? 'src/foo.py'),
    lineCount: options.lineCount ?? 3,
    getText: () => options.text ?? 'hello\nworld\n',
  };
}

function fakeChangeEvent(
  path: string,
  changes: Array<{
    startLine: number;
    startChar: number;
    endLine: number;
    endChar: number;
    text: string;
  }>,
) {
  return {
    document: fakeDoc({ path }),
    contentChanges: changes.map((c) => ({
      range: {
        start: { line: c.startLine, character: c.startChar },
        end: { line: c.endLine, character: c.endChar },
      },
      text: c.text,
      rangeOffset: 0,
      rangeLength: c.text.length,
    })),
  };
}

const testWorkspace: WorkspaceLike = {
  asRelativePath: (uri) => (uri as { fsPath: string }).fsPath,
};

function makeEmitters() {
  return {
    emitDocOpen: vi.fn(),
    emitDocChange: vi.fn(),
    emitDocSave: vi.fn(),
    emitDocClose: vi.fn(),
    emitSelectionChange: vi.fn(),
    emitFocusChange: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('startDocWiring', () => {
  it('registers all 6 subscriptions and disposes cleanly', () => {
    setMockWindowState({ focused: true });
    const registry = new ExpectedContentRegistry(['src/foo.py']);
    const emitters = makeEmitters();
    const disposable = startDocWiring({
      workspace: testWorkspace,
      ...emitters,
      filesUnderReview: ['src/foo.py'],
      expectedContent: registry,
    });

    expect(openSub.handler).not.toBeNull();
    expect(changeSub.handler).not.toBeNull();
    expect(saveSub.handler).not.toBeNull();
    expect(closeSub.handler).not.toBeNull();
    expect(selectionSub.handler).not.toBeNull();
    expect(focusSub.handler).not.toBeNull();

    disposable.dispose();

    expect(openSub.handler).toBeNull();
    expect(changeSub.handler).toBeNull();
    expect(saveSub.handler).toBeNull();
    expect(closeSub.handler).toBeNull();
    expect(selectionSub.handler).toBeNull();
    expect(focusSub.handler).toBeNull();
  });

  it('doc.open for watched file: creates registry entry and emits with hash', () => {
    setMockWindowState({ focused: true });
    const registry = new ExpectedContentRegistry(['src/foo.py']);
    const emitters = makeEmitters();
    startDocWiring({
      workspace: testWorkspace,
      ...emitters,
      filesUnderReview: ['src/foo.py'],
      expectedContent: registry,
    });

    const doc = fakeDoc({ path: 'src/foo.py', text: 'content', lineCount: 1 });
    openSub.handler!(doc);

    expect(emitters.emitDocOpen).toHaveBeenCalledOnce();
    const payload = emitters.emitDocOpen.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.path).toBe('src/foo.py');
    expect(typeof payload.sha256).toBe('string');
    expect((payload.sha256 as string).length).toBe(64);
    expect(payload.line_count).toBe(1);

    expect(registry.get('src/foo.py')).toBeDefined();
  });

  it('doc.open for unwatched file: emits event but does NOT create registry entry', () => {
    setMockWindowState({ focused: true });
    const registry = new ExpectedContentRegistry(['src/foo.py']);
    const emitters = makeEmitters();
    startDocWiring({
      workspace: testWorkspace,
      ...emitters,
      filesUnderReview: ['src/foo.py'],
      expectedContent: registry,
    });

    const doc = fakeDoc({ path: 'src/other.py', text: 'other content', lineCount: 2 });
    openSub.handler!(doc);

    // Still emits doc.open for all workspace files (PRD §4.2)
    expect(emitters.emitDocOpen).toHaveBeenCalledOnce();
    const payload = emitters.emitDocOpen.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.path).toBe('src/other.py');

    // Registry should NOT have entry for the unwatched file
    expect(registry.get('src/other.py')).toBeUndefined();
  });

  it('doc.change emits with correct path, deltas, and source=typed', () => {
    setMockWindowState({ focused: true });
    const registry = new ExpectedContentRegistry(['src/foo.py']);
    const emitters = makeEmitters();
    startDocWiring({
      workspace: testWorkspace,
      ...emitters,
      filesUnderReview: ['src/foo.py'],
      expectedContent: registry,
    });

    const event = fakeChangeEvent('src/foo.py', [
      { startLine: 0, startChar: 0, endLine: 0, endChar: 3, text: 'new' },
    ]);
    changeSub.handler!(event);

    expect(emitters.emitDocChange).toHaveBeenCalledOnce();
    const payload = emitters.emitDocChange.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.path).toBe('src/foo.py');
    expect(Array.isArray(payload.deltas)).toBe(true);
    expect((payload.deltas as unknown[]).length).toBe(1);
    expect(payload.source).toBe('typed');
  });

  it('doc.change applies deltas to ExpectedContent for watched files', () => {
    setMockWindowState({ focused: true });
    const registry = new ExpectedContentRegistry(['src/foo.py']);
    const emitters = makeEmitters();
    startDocWiring({
      workspace: testWorkspace,
      ...emitters,
      filesUnderReview: ['src/foo.py'],
      expectedContent: registry,
    });

    // Open first to populate registry
    const doc = fakeDoc({ path: 'src/foo.py', text: 'hello', lineCount: 1 });
    openSub.handler!(doc);

    const ecBefore = registry.get('src/foo.py')!;
    const hashBefore = ecBefore.hash;

    const event = fakeChangeEvent('src/foo.py', [
      { startLine: 0, startChar: 0, endLine: 0, endChar: 0, text: 'X' },
    ]);
    changeSub.handler!(event);

    expect(ecBefore.hash).not.toBe(hashBefore);
    expect(ecBefore.content).toBe('Xhello');
  });

  it('doc.change for unwatched file still emits but does not create registry entry', () => {
    setMockWindowState({ focused: true });
    const registry = new ExpectedContentRegistry(['src/foo.py']);
    const emitters = makeEmitters();
    startDocWiring({
      workspace: testWorkspace,
      ...emitters,
      filesUnderReview: ['src/foo.py'],
      expectedContent: registry,
    });

    const event = fakeChangeEvent('src/other.py', [
      { startLine: 0, startChar: 0, endLine: 0, endChar: 0, text: 'X' },
    ]);
    changeSub.handler!(event);

    expect(emitters.emitDocChange).toHaveBeenCalledOnce();
    expect(registry.get('src/other.py')).toBeUndefined();
  });

  it('doc.save emits with path and sha256', () => {
    setMockWindowState({ focused: true });
    const registry = new ExpectedContentRegistry(['src/foo.py']);
    const emitters = makeEmitters();
    startDocWiring({
      workspace: testWorkspace,
      ...emitters,
      filesUnderReview: ['src/foo.py'],
      expectedContent: registry,
    });

    const doc = fakeDoc({ path: 'src/foo.py', text: 'content', lineCount: 1 });
    openSub.handler!(doc);
    saveSub.handler!(doc);

    expect(emitters.emitDocSave).toHaveBeenCalledOnce();
    const payload = emitters.emitDocSave.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.path).toBe('src/foo.py');
    expect(typeof payload.sha256).toBe('string');
    expect((payload.sha256 as string).length).toBe(64);
  });

  it('doc.close emits correct path and does NOT delete registry entry', () => {
    setMockWindowState({ focused: true });
    const registry = new ExpectedContentRegistry(['src/foo.py']);
    const emitters = makeEmitters();
    startDocWiring({
      workspace: testWorkspace,
      ...emitters,
      filesUnderReview: ['src/foo.py'],
      expectedContent: registry,
    });

    const doc = fakeDoc({ path: 'src/foo.py', text: 'content', lineCount: 1 });
    openSub.handler!(doc);
    expect(registry.get('src/foo.py')).toBeDefined();

    closeSub.handler!(doc);

    expect(emitters.emitDocClose).toHaveBeenCalledOnce();
    const payload = emitters.emitDocClose.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.path).toBe('src/foo.py');

    // Entry persists (close+reopen is common; keep history)
    expect(registry.get('src/foo.py')).toBeDefined();
  });

  it('selection.change emits correct payload for selection', () => {
    setMockWindowState({ focused: true });
    const registry = new ExpectedContentRegistry(['src/foo.py']);
    const emitters = makeEmitters();
    startDocWiring({
      workspace: testWorkspace,
      ...emitters,
      filesUnderReview: ['src/foo.py'],
      expectedContent: registry,
    });

    const selEvent = {
      textEditor: { document: fakeDoc({ path: 'src/foo.py' }) },
      selections: [
        {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 5 },
          isEmpty: false,
          isReversed: false,
          active: { line: 0, character: 5 },
          anchor: { line: 0, character: 0 },
        },
      ],
      kind: undefined,
    };
    selectionSub.handler!(selEvent);

    expect(emitters.emitSelectionChange).toHaveBeenCalledOnce();
    const payload = emitters.emitSelectionChange.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.was_selection).toBe(true);
    expect(payload.path).toBe('src/foo.py');
  });

  it('focus.change emits only on state transition', () => {
    setMockWindowState({ focused: true });
    const registry = new ExpectedContentRegistry([]);
    const emitters = makeEmitters();
    startDocWiring({
      workspace: testWorkspace,
      ...emitters,
      filesUnderReview: [],
      expectedContent: registry,
    });

    // Transition: focused → not focused
    focusSub.handler!({ focused: false });
    expect(emitters.emitFocusChange).toHaveBeenCalledOnce();
    expect((emitters.emitFocusChange.mock.calls[0]![0] as Record<string, unknown>).gained).toBe(
      false,
    );

    // Transition: not focused → focused
    focusSub.handler!({ focused: true });
    expect(emitters.emitFocusChange).toHaveBeenCalledTimes(2);
    expect((emitters.emitFocusChange.mock.calls[1]![0] as Record<string, unknown>).gained).toBe(
      true,
    );
  });

  it('focus.change does NOT emit when state does not change', () => {
    setMockWindowState({ focused: true });
    const registry = new ExpectedContentRegistry([]);
    const emitters = makeEmitters();
    startDocWiring({
      workspace: testWorkspace,
      ...emitters,
      filesUnderReview: [],
      expectedContent: registry,
    });

    // Same state: focused → focused (no transition)
    focusSub.handler!({ focused: true });
    expect(emitters.emitFocusChange).not.toHaveBeenCalled();
  });
});
