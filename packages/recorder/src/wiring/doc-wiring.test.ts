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
  getMockTextDocuments,
  setMockTextDocuments,
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
  let _textDocuments: unknown[] = [];

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
    getMockTextDocuments: () => _textDocuments,
    setMockTextDocuments: (docs: unknown[]) => {
      _textDocuments = docs;
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
    get textDocuments() {
      return getMockTextDocuments();
    },
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
import { sha256Hex } from '@provenance/log-core';

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
    emitPaste: vi.fn(),
    emitSelectionChange: vi.fn(),
    emitFocusChange: vi.fn(),
    emitFsExternalChange: vi.fn(),
  };
}

function makeLargeInsertCounter() {
  let n = 0;
  return {
    increment: () => {
      n++;
    },
    count: () => n,
    _getCount: () => n,
  };
}

/** A null-like paste intercept: never confirms a paste. */
function makeNullIntercept() {
  return null;
}

/** A paste intercept that immediately confirms the next consumeIfPasteExpected call. */
function makeConfirmingIntercept() {
  let armed = false;
  return {
    disposable: { dispose: () => undefined },
    interceptCount: 0,
    arm: () => {
      armed = true;
    },
    consumeIfPasteExpected: (_now: number, _within?: number) => {
      if (armed) {
        armed = false;
        return true;
      }
      return false;
    },
  };
}

/** Shared paste-detection deps for tests that don't care about paste behavior. */
function makeDefaultPasteDeps() {
  return {
    pasteIntercept: makeNullIntercept(),
    largeInsertCounter: makeLargeInsertCounter(),
    getNow: () => 0,
    // Default: readFile resolves with empty string. Tests that need specific content override this.
    readFile: vi.fn().mockResolvedValue(''),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

import { beforeEach } from 'vitest';

describe('startDocWiring', () => {
  // Reset textDocuments before each test to prevent state leakage between
  // tests that call setMockTextDocuments().
  beforeEach(() => {
    setMockTextDocuments([]);
  });

  it('registers all 6 subscriptions and disposes cleanly', () => {
    setMockWindowState({ focused: true });
    const registry = new ExpectedContentRegistry(['src/foo.py']);
    const emitters = makeEmitters();
    const disposable = startDocWiring({
      workspace: testWorkspace,
      ...emitters,
      filesUnderReview: ['src/foo.py'],
      expectedContent: registry,
      ...makeDefaultPasteDeps(),
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
      ...makeDefaultPasteDeps(),
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
      ...makeDefaultPasteDeps(),
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
      ...makeDefaultPasteDeps(),
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
      ...makeDefaultPasteDeps(),
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
      ...makeDefaultPasteDeps(),
    });

    const event = fakeChangeEvent('src/other.py', [
      { startLine: 0, startChar: 0, endLine: 0, endChar: 0, text: 'X' },
    ]);
    changeSub.handler!(event);

    expect(emitters.emitDocChange).toHaveBeenCalledOnce();
    expect(registry.get('src/other.py')).toBeUndefined();
  });

  it('doc.save emits with path and sha256', async () => {
    setMockWindowState({ focused: true });
    const content = 'content';
    const registry = new ExpectedContentRegistry(['src/foo.py']);
    const emitters = makeEmitters();
    startDocWiring({
      workspace: testWorkspace,
      ...emitters,
      filesUnderReview: ['src/foo.py'],
      expectedContent: registry,
      ...makeDefaultPasteDeps(),
      // readFile returns the same content as expected — clean save
      readFile: vi.fn().mockResolvedValue(content),
    });

    const doc = fakeDoc({ path: 'src/foo.py', text: content, lineCount: 1 });
    openSub.handler!(doc);
    saveSub.handler!(doc);

    // doc.save is now async (awaits readFile); flush microtasks
    await new Promise((resolve) => setTimeout(resolve, 0));

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
      ...makeDefaultPasteDeps(),
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
      ...makeDefaultPasteDeps(),
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
      ...makeDefaultPasteDeps(),
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
      ...makeDefaultPasteDeps(),
    });

    // Same state: focused → focused (no transition)
    focusSub.handler!({ focused: true });
    expect(emitters.emitFocusChange).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Paste detection tests (Phase 6)
  // -------------------------------------------------------------------------

  it('paste_likely doc.change: emits paste event (not doc.change)', () => {
    setMockWindowState({ focused: true });
    const registry = new ExpectedContentRegistry(['src/foo.py']);
    const emitters = makeEmitters();
    startDocWiring({
      workspace: testWorkspace,
      ...emitters,
      filesUnderReview: ['src/foo.py'],
      expectedContent: registry,
      ...makeDefaultPasteDeps(),
    });

    const longText = 'x'.repeat(30);
    const event = fakeChangeEvent('src/foo.py', [
      { startLine: 0, startChar: 0, endLine: 0, endChar: 0, text: longText },
    ]);
    changeSub.handler!(event);

    expect(emitters.emitPaste).toHaveBeenCalledOnce();
    expect(emitters.emitDocChange).not.toHaveBeenCalled();
  });

  it('paste event has correct path, range, length, sha256', () => {
    setMockWindowState({ focused: true });
    const registry = new ExpectedContentRegistry(['src/foo.py']);
    const emitters = makeEmitters();
    startDocWiring({
      workspace: testWorkspace,
      ...emitters,
      filesUnderReview: ['src/foo.py'],
      expectedContent: registry,
      ...makeDefaultPasteDeps(),
    });

    const longText = 'a'.repeat(50);
    const event = fakeChangeEvent('src/foo.py', [
      { startLine: 2, startChar: 5, endLine: 2, endChar: 5, text: longText },
    ]);
    changeSub.handler!(event);

    const payload = emitters.emitPaste.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.path).toBe('src/foo.py');
    expect((payload.range as { start: { line: number } }).start.line).toBe(2);
    expect(payload.length).toBe(50);
    expect(typeof payload.sha256).toBe('string');
    expect((payload.sha256 as string).length).toBe(64);
    expect(payload.content).toBe(longText); // 50 bytes <= 4096
  });

  it('short typed change: emits doc.change (not paste)', () => {
    setMockWindowState({ focused: true });
    const registry = new ExpectedContentRegistry(['src/foo.py']);
    const emitters = makeEmitters();
    startDocWiring({
      workspace: testWorkspace,
      ...emitters,
      filesUnderReview: ['src/foo.py'],
      expectedContent: registry,
      ...makeDefaultPasteDeps(),
    });

    const event = fakeChangeEvent('src/foo.py', [
      { startLine: 0, startChar: 0, endLine: 0, endChar: 0, text: 'x' },
    ]);
    changeSub.handler!(event);

    expect(emitters.emitDocChange).toHaveBeenCalledOnce();
    expect(emitters.emitPaste).not.toHaveBeenCalled();
  });

  it('large insert with non-empty range: emits doc.change (deletion present → not paste)', () => {
    setMockWindowState({ focused: true });
    const registry = new ExpectedContentRegistry(['src/foo.py']);
    const emitters = makeEmitters();
    startDocWiring({
      workspace: testWorkspace,
      ...emitters,
      filesUnderReview: ['src/foo.py'],
      expectedContent: registry,
      ...makeDefaultPasteDeps(),
    });

    const longText = 'x'.repeat(30);
    const event = fakeChangeEvent('src/foo.py', [
      // non-empty range = deletion present
      { startLine: 0, startChar: 0, endLine: 0, endChar: 5, text: longText },
    ]);
    changeSub.handler!(event);

    expect(emitters.emitDocChange).toHaveBeenCalledOnce();
    expect(emitters.emitPaste).not.toHaveBeenCalled();
  });

  it('large-insert counter increments on paste_likely, not on typed', () => {
    setMockWindowState({ focused: true });
    const registry = new ExpectedContentRegistry([]);
    const emitters = makeEmitters();
    const counter = makeLargeInsertCounter();
    startDocWiring({
      workspace: testWorkspace,
      ...emitters,
      filesUnderReview: [],
      expectedContent: registry,
      pasteIntercept: makeNullIntercept(),
      largeInsertCounter: counter,
      getNow: () => 0,
      readFile: vi.fn().mockResolvedValue(''),
    });

    // typed change — counter should NOT increment
    changeSub.handler!(
      fakeChangeEvent('src/foo.py', [
        { startLine: 0, startChar: 0, endLine: 0, endChar: 0, text: 'hi' },
      ]),
    );
    expect(counter.count()).toBe(0);

    // paste_likely change — counter SHOULD increment
    changeSub.handler!(
      fakeChangeEvent('src/foo.py', [
        { startLine: 0, startChar: 0, endLine: 0, endChar: 0, text: 'x'.repeat(30) },
      ]),
    );
    expect(counter.count()).toBe(1);
  });

  it('paste_confirmed (intercept just before doc.change): still emits paste event', () => {
    setMockWindowState({ focused: true });
    const registry = new ExpectedContentRegistry([]);
    const emitters = makeEmitters();
    const confirmingIntercept = makeConfirmingIntercept();
    confirmingIntercept.arm();

    startDocWiring({
      workspace: testWorkspace,
      ...emitters,
      filesUnderReview: [],
      expectedContent: registry,
      pasteIntercept: confirmingIntercept,
      largeInsertCounter: makeLargeInsertCounter(),
      getNow: () => 1000,
      readFile: vi.fn().mockResolvedValue(''),
    });

    const event = fakeChangeEvent('src/foo.py', [
      { startLine: 0, startChar: 0, endLine: 0, endChar: 0, text: 'x'.repeat(30) },
    ]);
    changeSub.handler!(event);

    // Whether confirmed or likely, both paths emit a 'paste' event
    expect(emitters.emitPaste).toHaveBeenCalledOnce();
    expect(emitters.emitDocChange).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Phase 7: external-change detection on doc.save
  // -------------------------------------------------------------------------

  it('doc.save with on-disk content matching expected: emits only doc.save', async () => {
    setMockWindowState({ focused: true });
    const content = 'def foo(): pass\n';
    const registry = new ExpectedContentRegistry(['src/foo.py']);
    const emitters = makeEmitters();

    startDocWiring({
      workspace: testWorkspace,
      ...emitters,
      filesUnderReview: ['src/foo.py'],
      expectedContent: registry,
      ...makeDefaultPasteDeps(),
      // readFile returns the same content as what's in the expected registry
      readFile: vi.fn().mockResolvedValue(content),
    });

    // Open to register expected content
    const doc = fakeDoc({ path: 'src/foo.py', text: content, lineCount: 1 });
    openSub.handler!(doc);

    // Trigger save
    saveSub.handler!(doc);

    // Wait for async readFile + emit
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(emitters.emitDocSave).toHaveBeenCalledOnce();
    expect(emitters.emitFsExternalChange).not.toHaveBeenCalled();

    const savePayload = emitters.emitDocSave.mock.calls[0]![0] as Record<string, unknown>;
    expect(savePayload.sha256).toBe(sha256Hex(content));
  });

  it('doc.save with on-disk content DIFFERENT from expected: emits fs.external_change then doc.save', async () => {
    setMockWindowState({ focused: true });
    const expectedContent = 'def foo(): pass\n';
    const onDiskContent = 'def foo(): return 42  # externally edited\n';
    const registry = new ExpectedContentRegistry(['src/foo.py']);
    const emitters = makeEmitters();

    startDocWiring({
      workspace: testWorkspace,
      ...emitters,
      filesUnderReview: ['src/foo.py'],
      expectedContent: registry,
      ...makeDefaultPasteDeps(),
      readFile: vi.fn().mockResolvedValue(onDiskContent),
    });

    // Open to register expected content with original content
    const doc = fakeDoc({ path: 'src/foo.py', text: expectedContent, lineCount: 1 });
    openSub.handler!(doc);

    // Trigger save
    saveSub.handler!(doc);

    await new Promise((resolve) => setTimeout(resolve, 0));

    // fs.external_change must be emitted BEFORE doc.save
    expect(emitters.emitFsExternalChange).toHaveBeenCalledOnce();
    expect(emitters.emitDocSave).toHaveBeenCalledOnce();

    const extPayload = emitters.emitFsExternalChange.mock.calls[0]![0] as Record<string, unknown>;
    expect(extPayload.path).toBe('src/foo.py');
    expect(extPayload.old_hash).toBe(sha256Hex(expectedContent));
    expect(extPayload.new_hash).toBe(sha256Hex(onDiskContent));

    const savePayload = emitters.emitDocSave.mock.calls[0]![0] as Record<string, unknown>;
    expect(savePayload.sha256).toBe(sha256Hex(onDiskContent));
  });

  it('doc.save external change: registry expected content reset to on-disk content', async () => {
    setMockWindowState({ focused: true });
    const expectedContent = 'original';
    const onDiskContent = 'externally modified content';
    const registry = new ExpectedContentRegistry(['src/foo.py']);
    const emitters = makeEmitters();

    startDocWiring({
      workspace: testWorkspace,
      ...emitters,
      filesUnderReview: ['src/foo.py'],
      expectedContent: registry,
      ...makeDefaultPasteDeps(),
      readFile: vi.fn().mockResolvedValue(onDiskContent),
    });

    const doc = fakeDoc({ path: 'src/foo.py', text: expectedContent, lineCount: 1 });
    openSub.handler!(doc);
    saveSub.handler!(doc);

    await new Promise((resolve) => setTimeout(resolve, 0));

    // After the save handler runs, the registry should reflect on-disk reality
    const ec = registry.get('src/foo.py');
    expect(ec?.content).toBe(onDiskContent);
    expect(ec?.hash).toBe(sha256Hex(onDiskContent));
  });

  it('getLastDocChangeAt returns -Infinity for unseen path, then updates on doc.change', () => {
    setMockWindowState({ focused: true });
    const registry = new ExpectedContentRegistry(['src/foo.py']);
    const emitters = makeEmitters();
    let nowVal = 1234;
    const handle = startDocWiring({
      workspace: testWorkspace,
      ...emitters,
      filesUnderReview: ['src/foo.py'],
      expectedContent: registry,
      pasteIntercept: makeNullIntercept(),
      largeInsertCounter: makeLargeInsertCounter(),
      getNow: () => nowVal,
      readFile: vi.fn().mockResolvedValue(''),
    });

    expect(handle.getLastDocChangeAt('src/foo.py')).toBe(-Infinity);

    nowVal = 9999;
    const event = fakeChangeEvent('src/foo.py', [
      { startLine: 0, startChar: 0, endLine: 0, endChar: 0, text: 'x' },
    ]);
    changeSub.handler!(event);

    expect(handle.getLastDocChangeAt('src/foo.py')).toBe(9999);
  });

  it('empty-delta doc.change updates lastDocChangeAt even though no emitDocChange', () => {
    // Regression test for Fix 2: empty-delta events (dirty-flag toggles, encoding changes)
    // must update lastDocChangeAt for fs-watcher tolerance. They don't emit doc.change,
    // but they do represent a document touch.
    setMockWindowState({ focused: true });
    const registry = new ExpectedContentRegistry(['src/foo.py']);
    const emitters = makeEmitters();
    const nowVal = 5000;
    const handle = startDocWiring({
      workspace: testWorkspace,
      ...emitters,
      filesUnderReview: ['src/foo.py'],
      expectedContent: registry,
      pasteIntercept: makeNullIntercept(),
      largeInsertCounter: makeLargeInsertCounter(),
      getNow: () => nowVal,
      readFile: vi.fn().mockResolvedValue(''),
    });

    // Simulate an empty-delta event (contentChanges is empty).
    const emptyEvent = {
      document: fakeDoc({ path: 'src/foo.py' }),
      contentChanges: [],
    };
    changeSub.handler!(emptyEvent);

    // Should NOT emit doc.change or paste (empty-delta is noise)
    expect(emitters.emitDocChange).not.toHaveBeenCalled();
    expect(emitters.emitPaste).not.toHaveBeenCalled();

    // But lastDocChangeAt SHOULD be updated to track the document touch
    expect(handle.getLastDocChangeAt('src/foo.py')).toBe(5000);
  });

  // -------------------------------------------------------------------------
  // Issue C fix: filter empty-delta doc.change events (recorder v1.1)
  // -------------------------------------------------------------------------

  it('doc.change with contentChanges=[] does NOT emit emitDocChange (non-content VS Code event)', () => {
    setMockWindowState({ focused: true });
    setMockTextDocuments([]);
    const registry = new ExpectedContentRegistry(['src/foo.py']);
    const emitters = makeEmitters();
    startDocWiring({
      workspace: testWorkspace,
      ...emitters,
      filesUnderReview: ['src/foo.py'],
      expectedContent: registry,
      ...makeDefaultPasteDeps(),
    });

    // Simulate a non-content VS Code change event (contentChanges is empty).
    const emptyEvent = {
      document: fakeDoc({ path: 'src/foo.py' }),
      contentChanges: [],
    };
    changeSub.handler!(emptyEvent);

    expect(emitters.emitDocChange).not.toHaveBeenCalled();
    expect(emitters.emitPaste).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Issue A fix: synthetic doc.open for already-open documents (recorder v1.1)
  // -------------------------------------------------------------------------

  it('emits doc.open for in-workspace documents already open at activation', () => {
    setMockWindowState({ focused: true });
    setMockTextDocuments([]);
    // One in-workspace doc (relative path != fsPath) and one outside-workspace doc
    // (asRelativePath returns the fsPath unchanged when outside workspace).
    const inWorkspaceDoc = {
      uri: { fsPath: '/workspace/src/hw.py', scheme: 'file' },
      lineCount: 2,
      getText: () => '# placeholder\n',
    };
    const outsideDoc = {
      // testWorkspace.asRelativePath returns uri.fsPath, which equals the
      // fsPath → this document is treated as outside-workspace and skipped.
      uri: { fsPath: '/outside/some.py', scheme: 'file' },
      lineCount: 1,
      getText: () => 'pass\n',
    };
    setMockTextDocuments([inWorkspaceDoc, outsideDoc]);

    // Use a workspace where in-workspace docs return a shorter relative path
    // (different from fsPath). The testWorkspace returns uri.fsPath as-is, so
    // we need a custom workspace for this test.
    const workspaceWithRoot: WorkspaceLike = {
      asRelativePath: (uri) => {
        const fsPath = (uri as { fsPath: string }).fsPath;
        if (fsPath.startsWith('/workspace/')) {
          return fsPath.slice('/workspace/'.length); // 'src/hw.py'
        }
        return fsPath; // outside workspace: unchanged
      },
    };

    const registry = new ExpectedContentRegistry([]);
    const emitters = makeEmitters();
    startDocWiring({
      workspace: workspaceWithRoot,
      ...emitters,
      filesUnderReview: [],
      expectedContent: registry,
      ...makeDefaultPasteDeps(),
    });

    // Should emit exactly ONE doc.open: for the in-workspace doc.
    expect(emitters.emitDocOpen).toHaveBeenCalledOnce();
    const payload = emitters.emitDocOpen.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.path).toBe('src/hw.py');
    expect(payload.content).toBe('# placeholder\n');
    // sha256 must be a 64-char hex string
    expect(typeof payload.sha256).toBe('string');
    expect((payload.sha256 as string).length).toBe(64);
  });

  it('does not double-emit doc.open when onDidOpenTextDocument fires for a synthetic doc', () => {
    setMockWindowState({ focused: true });
    const alreadyOpenDoc = {
      uri: { fsPath: '/workspace/src/hw.py', scheme: 'file' },
      lineCount: 2,
      getText: () => '# placeholder\n',
    };
    setMockTextDocuments([alreadyOpenDoc]);

    const workspaceWithRoot: WorkspaceLike = {
      asRelativePath: (uri) => {
        const fsPath = (uri as { fsPath: string }).fsPath;
        return fsPath.startsWith('/workspace/') ? fsPath.slice('/workspace/'.length) : fsPath;
      },
    };

    const registry = new ExpectedContentRegistry([]);
    const emitters = makeEmitters();
    startDocWiring({
      workspace: workspaceWithRoot,
      ...emitters,
      filesUnderReview: [],
      expectedContent: registry,
      ...makeDefaultPasteDeps(),
    });

    // Synthetic emit happened at startup.
    expect(emitters.emitDocOpen).toHaveBeenCalledOnce();

    // Simulate VS Code re-firing onDidOpenTextDocument for the same doc
    // (defensive guard test).
    openSub.handler!(alreadyOpenDoc);

    // seenDocs Set must prevent a second emit.
    expect(emitters.emitDocOpen).toHaveBeenCalledOnce();
  });
});
