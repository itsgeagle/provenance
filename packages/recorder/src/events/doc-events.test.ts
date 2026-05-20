/**
 * Tests for pure doc-event transformers.
 * No real vscode module needed — everything uses fake objects.
 */

import { describe, expect, it } from 'vitest';
import {
  transformDocOpen,
  transformDocChange,
  transformDocSave,
  transformDocClose,
  transformSelectionChange,
  transformFocusChange,
  type WorkspaceLike,
} from './doc-events.js';

// ---------------------------------------------------------------------------
// Shared test stub
// ---------------------------------------------------------------------------

const fakeWorkspace: WorkspaceLike = {
  asRelativePath: (_uri) => 'src/foo.py',
};

function fakeUri(fsPath = '/workspace/src/foo.py') {
  return { fsPath, scheme: 'file' };
}

function fakeDoc(options: { lineCount?: number; text?: string; uriPath?: string } = {}) {
  return {
    uri: fakeUri(options.uriPath ?? '/workspace/src/foo.py'),
    lineCount: options.lineCount ?? 5,
    getText: () => options.text ?? 'hello\nworld\n',
  };
}

function fakePosition(line: number, character: number) {
  return { line, character };
}

function fakeRange(startLine: number, startChar: number, endLine: number, endChar: number) {
  return {
    start: fakePosition(startLine, startChar),
    end: fakePosition(endLine, endChar),
  };
}

// ---------------------------------------------------------------------------
// transformDocOpen
// ---------------------------------------------------------------------------

describe('transformDocOpen', () => {
  it('returns correct path, sha256, line_count, and content for small document', () => {
    const doc = fakeDoc({ lineCount: 7, text: 'hello\nworld\n' });
    const result = transformDocOpen(doc as never, fakeWorkspace, 'abc123hash', 'hello\nworld\n');
    expect(result).toEqual({
      path: 'src/foo.py',
      sha256: 'abc123hash',
      line_count: 7,
      content: 'hello\nworld\n',
    });
  });

  it('uses the injected hash (not recomputed)', () => {
    const doc = fakeDoc({ lineCount: 1, text: 'x' });
    const result = transformDocOpen(doc as never, fakeWorkspace, 'deadbeef', 'x');
    expect(result.sha256).toBe('deadbeef');
  });

  it('inlines content for a document exactly at the 64 KB limit', () => {
    // 64 KB of ASCII characters — one byte each.
    const text = 'a'.repeat(64 * 1024);
    const doc = fakeDoc({ lineCount: 1, text });
    const result = transformDocOpen(doc as never, fakeWorkspace, 'hash64k', text);
    expect(result.content).toBe(text);
    expect(result.truncated).toBeUndefined();
  });

  it('sets truncated=true for a document exceeding 64 KB, omits content', () => {
    // 64 KB + 1 byte.
    const text = 'a'.repeat(64 * 1024 + 1);
    const doc = fakeDoc({ lineCount: 1, text });
    const result = transformDocOpen(doc as never, fakeWorkspace, 'hashbig', text);
    expect(result.content).toBeUndefined();
    expect(result.truncated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// transformDocChange
// ---------------------------------------------------------------------------

describe('transformDocChange', () => {
  it('builds correct path, deltas array, and source', () => {
    const event = {
      document: fakeDoc(),
      contentChanges: [
        {
          range: fakeRange(0, 0, 0, 3),
          text: 'foo',
          rangeOffset: 0,
          rangeLength: 3,
        },
      ],
    };
    const result = transformDocChange(event as never, fakeWorkspace);
    expect(result.path).toBe('src/foo.py');
    expect(result.source).toBe('typed');
    expect(result.deltas).toHaveLength(1);
    expect(result.deltas[0]).toEqual({
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
      text: 'foo',
    });
  });

  it('converts vscode.Position objects to plain {line, character}', () => {
    // vscode.Position may have extra properties; we only want line and character
    const richPosition = {
      line: 2,
      character: 5,
      isAfter: () => false,
      isBefore: () => false,
      isBeforeOrEqual: () => false,
      translate: () => null,
    };
    const event = {
      document: fakeDoc(),
      contentChanges: [
        {
          range: { start: richPosition, end: { line: 2, character: 10, isBefore: () => true } },
          text: 'bar',
          rangeOffset: 15,
          rangeLength: 5,
        },
      ],
    };
    const result = transformDocChange(event as never, fakeWorkspace);
    expect(result.deltas[0]!.range.start).toEqual({ line: 2, character: 5 });
    expect(result.deltas[0]!.range.end).toEqual({ line: 2, character: 10 });
  });

  it('handles multiple deltas', () => {
    const event = {
      document: fakeDoc(),
      contentChanges: [
        { range: fakeRange(0, 0, 0, 1), text: 'A', rangeOffset: 0, rangeLength: 1 },
        { range: fakeRange(1, 0, 1, 1), text: 'B', rangeOffset: 6, rangeLength: 1 },
      ],
    };
    const result = transformDocChange(event as never, fakeWorkspace);
    expect(result.deltas).toHaveLength(2);
  });

  it('empty contentChanges produces empty deltas array', () => {
    const event = { document: fakeDoc(), contentChanges: [] };
    const result = transformDocChange(event as never, fakeWorkspace);
    expect(result.deltas).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// transformDocSave
// ---------------------------------------------------------------------------

describe('transformDocSave', () => {
  it('returns correct path and sha256', () => {
    const doc = fakeDoc();
    const result = transformDocSave(doc as never, fakeWorkspace, 'savehash');
    expect(result).toEqual({ path: 'src/foo.py', sha256: 'savehash' });
  });
});

// ---------------------------------------------------------------------------
// transformDocClose
// ---------------------------------------------------------------------------

describe('transformDocClose', () => {
  it('returns correct path', () => {
    const doc = fakeDoc();
    const result = transformDocClose(doc as never, fakeWorkspace);
    expect(result).toEqual({ path: 'src/foo.py' });
  });
});

// ---------------------------------------------------------------------------
// transformSelectionChange
// ---------------------------------------------------------------------------

describe('transformSelectionChange', () => {
  it('cursor-only (isEmpty) → was_selection: false', () => {
    const event = {
      textEditor: { document: fakeDoc() },
      selections: [
        {
          start: fakePosition(2, 3),
          end: fakePosition(2, 3),
          isEmpty: true,
          isReversed: false,
          active: fakePosition(2, 3),
          anchor: fakePosition(2, 3),
        },
      ],
      kind: undefined,
    };
    const result = transformSelectionChange(event as never, fakeWorkspace);
    expect(result.was_selection).toBe(false);
    expect(result.range).toEqual({
      start: { line: 2, character: 3 },
      end: { line: 2, character: 3 },
    });
    expect(result.path).toBe('src/foo.py');
  });

  it('non-empty selection → was_selection: true', () => {
    const event = {
      textEditor: { document: fakeDoc() },
      selections: [
        {
          start: fakePosition(0, 0),
          end: fakePosition(0, 5),
          isEmpty: false,
          isReversed: false,
          active: fakePosition(0, 5),
          anchor: fakePosition(0, 0),
        },
      ],
      kind: undefined,
    };
    const result = transformSelectionChange(event as never, fakeWorkspace);
    expect(result.was_selection).toBe(true);
    expect(result.range).toEqual({
      start: { line: 0, character: 0 },
      end: { line: 0, character: 5 },
    });
  });

  it('uses the FIRST selection (ignores subsequent)', () => {
    const event = {
      textEditor: { document: fakeDoc() },
      selections: [
        {
          start: fakePosition(0, 0),
          end: fakePosition(0, 3),
          isEmpty: false,
          isReversed: false,
          active: fakePosition(0, 3),
          anchor: fakePosition(0, 0),
        },
        {
          start: fakePosition(5, 0),
          end: fakePosition(5, 3),
          isEmpty: false,
          isReversed: false,
          active: fakePosition(5, 3),
          anchor: fakePosition(5, 0),
        },
      ],
      kind: undefined,
    };
    const result = transformSelectionChange(event as never, fakeWorkspace);
    expect(result.range.start).toEqual({ line: 0, character: 0 });
  });
});

// ---------------------------------------------------------------------------
// transformFocusChange
// ---------------------------------------------------------------------------

describe('transformFocusChange', () => {
  it('true→false transition emits {gained: false}', () => {
    const state = { focused: false };
    const result = transformFocusChange(state as never, true);
    expect(result).toEqual({ gained: false });
  });

  it('false→true transition emits {gained: true}', () => {
    const state = { focused: true };
    const result = transformFocusChange(state as never, false);
    expect(result).toEqual({ gained: true });
  });
});
