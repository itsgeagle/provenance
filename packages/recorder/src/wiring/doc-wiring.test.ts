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

// All in-workspace paths in tests live under a synthetic '/workspace/' root.
// `testWorkspace.asRelativePath` strips that prefix; the recorder's
// `isRecordable` guard treats anything where asRelativePath(uri) === uri.fsPath
// as out-of-workspace and skips it. Passing an already-absolute path
// (starts with '/') routes around the prefix so tests can simulate
// out-of-workspace URIs (e.g. '/outside/some.py').
function fakeUri(path = 'src/foo.py') {
  const fsPath = path.startsWith('/') ? path : `/workspace/${path}`;
  return { fsPath, scheme: 'file' };
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
  options: {
    /** Post-event buffer state. Default: dirty (normal typing). */
    isDirty?: boolean;
    /** TextDocumentChangeReason. Default: undefined (typing/paste/programmatic edit). */
    reason?: number | undefined;
    /** Post-event document text (for reload-from-disk tests). */
    bufferText?: string;
  } = {},
) {
  const doc = fakeDoc(
    options.bufferText !== undefined ? { path, text: options.bufferText } : { path },
  );
  return {
    document: { ...doc, isDirty: options.isDirty ?? true },
    contentChanges: changes.map((c) => ({
      range: {
        start: { line: c.startLine, character: c.startChar },
        end: { line: c.endLine, character: c.endChar },
      },
      text: c.text,
      rangeOffset: 0,
      rangeLength: c.text.length,
    })),
    reason: options.reason,
  };
}

const testWorkspace: WorkspaceLike = {
  asRelativePath: (uri) => {
    const fsPath = (uri as { fsPath: string }).fsPath;
    return fsPath.startsWith('/workspace/') ? fsPath.slice('/workspace/'.length) : fsPath;
  },
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
    // Default: readFileSync returns empty string. The reload-from-disk discriminator only
    // treats a change as a reload when on-disk content === the new buffer; tests exercising
    // that branch override this to return the expected on-disk content.
    readFileSync: vi.fn(() => ''),
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

  it('large insert with non-empty range: emits doc.change with source=paste_likely (replacement-shaped bulk edit)', () => {
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

    // Under the broadened classifier this is paste_likely (rule 1: any single
    // delta ≥ threshold), but routed through doc.change because the range
    // isn't empty — applyPaste can't reproduce a replacement.
    expect(emitters.emitDocChange).toHaveBeenCalledOnce();
    expect(emitters.emitPaste).not.toHaveBeenCalled();
    const payload = emitters.emitDocChange.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.source).toBe('paste_likely');
  });

  it('multi-delta WorkspaceEdit (tool-applied): emits doc.change with source=paste_likely', () => {
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

    // Two deltas, aggregate ≥ threshold, one carries a newline → rule 2.
    const event = fakeChangeEvent('src/foo.py', [
      { startLine: 0, startChar: 0, endLine: 0, endChar: 0, text: 'x'.repeat(20) },
      { startLine: 1, startChar: 0, endLine: 1, endChar: 0, text: 'line\nmore-line-text' },
    ]);
    changeSub.handler!(event);

    expect(emitters.emitDocChange).toHaveBeenCalledOnce();
    expect(emitters.emitPaste).not.toHaveBeenCalled();
    const payload = emitters.emitDocChange.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.source).toBe('paste_likely');
    expect(Array.isArray(payload.deltas)).toBe(true);
    expect((payload.deltas as unknown[]).length).toBe(2);
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
      readFileSync: vi.fn(() => ''),
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
      readFileSync: vi.fn(() => ''),
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
    // Recorder v1.3+: payload carries the on-disk content.
    expect(extPayload.new_content).toBe(onDiskContent);

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

  // -------------------------------------------------------------------------
  // Reload-from-disk detection (PRD §4.5)
  //
  // VS Code auto-reloads a clean buffer when its file changes on disk. The
  // resulting onDidChangeTextDocument has reason === undefined and
  // document.isDirty === false — a combination that typed/programmatic edits
  // never produce. Route it to fs.external_change.
  // -------------------------------------------------------------------------

  it('reload-from-disk (reason=undefined, isDirty=false): emits fs.external_change, NOT doc.change', () => {
    setMockWindowState({ focused: true });
    const before = 'def foo(): pass\n';
    const after = 'def foo(): return 42  # written by external tool\n';
    const registry = new ExpectedContentRegistry(['src/foo.py']);
    const emitters = makeEmitters();

    startDocWiring({
      workspace: testWorkspace,
      ...emitters,
      filesUnderReview: ['src/foo.py'],
      expectedContent: registry,
      ...makeDefaultPasteDeps(),
      // Genuine reload: the new buffer matches what's now on disk.
      readFileSync: vi.fn(() => after),
    });

    // Seed expected content via doc.open
    openSub.handler!(fakeDoc({ path: 'src/foo.py', text: before, lineCount: 1 }));

    // Simulate VS Code auto-reloading the buffer after an external write.
    const reloadEvent = fakeChangeEvent(
      'src/foo.py',
      [{ startLine: 0, startChar: 0, endLine: 1, endChar: 0, text: after }],
      { isDirty: false, reason: undefined, bufferText: after },
    );
    changeSub.handler!(reloadEvent);

    expect(emitters.emitFsExternalChange).toHaveBeenCalledOnce();
    expect(emitters.emitDocChange).not.toHaveBeenCalled();
    expect(emitters.emitPaste).not.toHaveBeenCalled();

    const payload = emitters.emitFsExternalChange.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.path).toBe('src/foo.py');
    expect(payload.old_hash).toBe(sha256Hex(before));
    expect(payload.new_hash).toBe(sha256Hex(after));
    expect(payload.diff_size).toBe(Math.abs(after.length - before.length));
    // Recorder v1.3+: payload carries the post-change content so the analyzer
    // can reseed reconstruction for replay.
    expect(payload.new_content).toBe(after);
    expect(payload.new_content_size).toBe(after.length);

    // Expected-content registry must be reset so the next save's hash matches reality.
    const ec = registry.get('src/foo.py');
    expect(ec?.content).toBe(after);
    expect(ec?.hash).toBe(sha256Hex(after));
  });

  it('first edit on a clean buffer (reason=undefined, isDirty=false) with disk holding OLD content: emits doc.change, NOT fs.external_change', () => {
    // Regression: VS Code delivers the content-change event BEFORE flipping
    // document.isDirty, so a student's first edit on a freshly-opened or
    // just-saved buffer arrives looking exactly like a reload candidate
    // (reason === undefined, isDirty === false). But the disk still holds the
    // unsaved OLD content, so the buffer has DIVERGED from disk → it's a real
    // edit, not a reload. (Real-world repro: cmd+delete right after a save.)
    setMockWindowState({ focused: true });
    const before = 'hello\n';
    const registry = new ExpectedContentRegistry(['src/foo.py']);
    const emitters = makeEmitters();

    startDocWiring({
      workspace: testWorkspace,
      ...emitters,
      filesUnderReview: ['src/foo.py'],
      expectedContent: registry,
      ...makeDefaultPasteDeps(),
      // Disk still holds the pre-edit content — the buffer has diverged.
      readFileSync: vi.fn(() => before),
    });

    openSub.handler!(fakeDoc({ path: 'src/foo.py', text: before, lineCount: 1 }));

    // First edit on the still-clean buffer: insert '!' → buffer becomes 'hello!\n'.
    const editEvent = fakeChangeEvent(
      'src/foo.py',
      [{ startLine: 0, startChar: 5, endLine: 0, endChar: 5, text: '!' }],
      { isDirty: false, reason: undefined, bufferText: 'hello!\n' },
    );
    changeSub.handler!(editEvent);

    expect(emitters.emitFsExternalChange).not.toHaveBeenCalled();
    expect(emitters.emitDocChange).toHaveBeenCalledOnce();

    // Expected-content model tracks the edit (deltas applied), not reset to disk.
    expect(registry.get('src/foo.py')?.content).toBe('hello!\n');
  });

  it('reload candidate where disk read throws: falls through to doc.change (does not relabel a real edit as external)', () => {
    setMockWindowState({ focused: true });
    const before = 'hello\n';
    const registry = new ExpectedContentRegistry(['src/foo.py']);
    const emitters = makeEmitters();

    startDocWiring({
      workspace: testWorkspace,
      ...emitters,
      filesUnderReview: ['src/foo.py'],
      expectedContent: registry,
      ...makeDefaultPasteDeps(),
      readFileSync: vi.fn(() => {
        throw new Error('ENOENT');
      }),
    });

    openSub.handler!(fakeDoc({ path: 'src/foo.py', text: before, lineCount: 1 }));

    const editEvent = fakeChangeEvent(
      'src/foo.py',
      [{ startLine: 0, startChar: 5, endLine: 0, endChar: 5, text: '!' }],
      { isDirty: false, reason: undefined, bufferText: 'hello!\n' },
    );
    changeSub.handler!(editEvent);

    expect(emitters.emitFsExternalChange).not.toHaveBeenCalled();
    expect(emitters.emitDocChange).toHaveBeenCalledOnce();
  });

  it('normal typing (isDirty=true): emits doc.change, NOT fs.external_change', () => {
    setMockWindowState({ focused: true });
    const before = 'hello\n';
    const registry = new ExpectedContentRegistry(['src/foo.py']);
    const emitters = makeEmitters();

    startDocWiring({
      workspace: testWorkspace,
      ...emitters,
      filesUnderReview: ['src/foo.py'],
      expectedContent: registry,
      ...makeDefaultPasteDeps(),
    });

    openSub.handler!(fakeDoc({ path: 'src/foo.py', text: before, lineCount: 1 }));

    const typedEvent = fakeChangeEvent(
      'src/foo.py',
      [{ startLine: 0, startChar: 5, endLine: 0, endChar: 5, text: '!' }],
      { isDirty: true },
    );
    changeSub.handler!(typedEvent);

    expect(emitters.emitDocChange).toHaveBeenCalledOnce();
    expect(emitters.emitFsExternalChange).not.toHaveBeenCalled();
  });

  it('undo to saved state (reason=Undo, isDirty=false): emits doc.change, NOT fs.external_change', () => {
    // TextDocumentChangeReason.Undo === 1 in VS Code's enum. We only treat
    // reason === undefined as a reload candidate; Undo/Redo are user actions.
    setMockWindowState({ focused: true });
    const before = 'x\n';
    const registry = new ExpectedContentRegistry(['src/foo.py']);
    const emitters = makeEmitters();

    startDocWiring({
      workspace: testWorkspace,
      ...emitters,
      filesUnderReview: ['src/foo.py'],
      expectedContent: registry,
      ...makeDefaultPasteDeps(),
    });

    openSub.handler!(fakeDoc({ path: 'src/foo.py', text: before, lineCount: 1 }));

    const undoEvent = fakeChangeEvent(
      'src/foo.py',
      [{ startLine: 0, startChar: 1, endLine: 0, endChar: 1, text: 'y' }],
      { isDirty: false, reason: 1 /* TextDocumentChangeReason.Undo */ },
    );
    changeSub.handler!(undoEvent);

    expect(emitters.emitFsExternalChange).not.toHaveBeenCalled();
    // Either doc.change or paste depending on size; for this single small
    // typed-shape delta, it's doc.change.
    expect(emitters.emitDocChange).toHaveBeenCalledOnce();
  });

  it('reload with identical content (touched, content same): emits nothing', () => {
    setMockWindowState({ focused: true });
    const content = 'unchanged\n';
    const registry = new ExpectedContentRegistry(['src/foo.py']);
    const emitters = makeEmitters();

    startDocWiring({
      workspace: testWorkspace,
      ...emitters,
      filesUnderReview: ['src/foo.py'],
      expectedContent: registry,
      ...makeDefaultPasteDeps(),
      // Buffer matches disk (a touch with identical content).
      readFileSync: vi.fn(() => content),
    });

    openSub.handler!(fakeDoc({ path: 'src/foo.py', text: content, lineCount: 1 }));

    // VS Code reload with no actual change (e.g. mtime touch). contentChanges
    // would be empty in this case; covered by the empty-delta path. But guard
    // against the unusual case where contentChanges replay identical text.
    const reloadEvent = fakeChangeEvent(
      'src/foo.py',
      [{ startLine: 0, startChar: 0, endLine: 1, endChar: 0, text: content }],
      { isDirty: false, reason: undefined, bufferText: content },
    );
    changeSub.handler!(reloadEvent);

    expect(emitters.emitFsExternalChange).not.toHaveBeenCalled();
    expect(emitters.emitDocChange).not.toHaveBeenCalled();
  });

  it('reload on unwatched file: falls through to doc.change path', () => {
    // Files not in files_under_review have no expected-content baseline, so
    // we cannot emit a meaningful fs.external_change. Fall through.
    setMockWindowState({ focused: true });
    const registry = new ExpectedContentRegistry(['src/watched.py']);
    const emitters = makeEmitters();

    startDocWiring({
      workspace: testWorkspace,
      ...emitters,
      filesUnderReview: ['src/watched.py'],
      expectedContent: registry,
      ...makeDefaultPasteDeps(),
    });

    const reloadEvent = fakeChangeEvent(
      'src/other.py',
      [{ startLine: 0, startChar: 0, endLine: 0, endChar: 0, text: 'x' }],
      { isDirty: false, reason: undefined },
    );
    changeSub.handler!(reloadEvent);

    expect(emitters.emitFsExternalChange).not.toHaveBeenCalled();
    expect(emitters.emitDocChange).toHaveBeenCalledOnce();
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
      readFileSync: vi.fn(() => ''),
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
      readFileSync: vi.fn(() => ''),
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

  // -------------------------------------------------------------------------
  // Recordability filter: scheme + in-workspace guard (PRD §4.1, §4.2)
  // -------------------------------------------------------------------------

  describe('recordability filter', () => {
    it('skips doc.open / doc.change / doc.save / doc.close / selection for non-file scheme', () => {
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

      const virtualDoc = {
        uri: { fsPath: '/workspace/src/foo.py', scheme: 'output' },
        lineCount: 1,
        getText: () => 'x',
      };

      openSub.handler!(virtualDoc);
      changeSub.handler!({
        document: virtualDoc,
        contentChanges: [
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 0 },
            },
            text: 'hello',
            rangeOffset: 0,
            rangeLength: 0,
          },
        ],
      });
      saveSub.handler!(virtualDoc);
      closeSub.handler!(virtualDoc);
      selectionSub.handler!({
        textEditor: { document: virtualDoc },
        selections: [
          {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 },
            isEmpty: true,
          },
        ],
      });

      expect(emitters.emitDocOpen).not.toHaveBeenCalled();
      expect(emitters.emitDocChange).not.toHaveBeenCalled();
      expect(emitters.emitPaste).not.toHaveBeenCalled();
      expect(emitters.emitDocSave).not.toHaveBeenCalled();
      expect(emitters.emitDocClose).not.toHaveBeenCalled();
      expect(emitters.emitSelectionChange).not.toHaveBeenCalled();
    });

    it('skips out-of-workspace file-scheme documents (e.g. VS Code settings.json, /terminal2.py)', () => {
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

      // Outside workspace: testWorkspace.asRelativePath returns the fsPath
      // verbatim (relPath === fsPath), so the filter rejects it.
      const outsideDoc = {
        uri: { fsPath: '/terminal2.py', scheme: 'file' },
        lineCount: 1,
        getText: () => 'print(1)\n',
      };

      openSub.handler!(outsideDoc);
      changeSub.handler!({
        document: outsideDoc,
        contentChanges: [
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 0 },
            },
            text: 'x',
            rangeOffset: 0,
            rangeLength: 0,
          },
        ],
      });
      saveSub.handler!(outsideDoc);
      closeSub.handler!(outsideDoc);

      expect(emitters.emitDocOpen).not.toHaveBeenCalled();
      expect(emitters.emitDocChange).not.toHaveBeenCalled();
      expect(emitters.emitPaste).not.toHaveBeenCalled();
      expect(emitters.emitDocSave).not.toHaveBeenCalled();
      expect(emitters.emitDocClose).not.toHaveBeenCalled();
    });

    it('records in-workspace file-scheme documents normally', () => {
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

      // fakeUri uses '/workspace/' prefix; testWorkspace strips it →
      // relPath !== fsPath → isRecordable() returns true.
      const doc = fakeDoc({ path: 'src/hw.py', text: 'x', lineCount: 1 });
      openSub.handler!(doc);

      expect(emitters.emitDocOpen).toHaveBeenCalledOnce();
      const payload = emitters.emitDocOpen.mock.calls[0]![0] as Record<string, unknown>;
      expect(payload.path).toBe('src/hw.py');
    });
  });
});
