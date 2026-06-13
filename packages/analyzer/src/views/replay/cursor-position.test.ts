/**
 * Tests for cursor-position.ts — pure helpers behind the replay cursor marker.
 */

import { describe, it, expect } from 'vitest';
import { currentSelection, toMonacoRange } from './cursor-position.js';
import type { IndexedEvent } from '../../index/event-index.js';
import type { EventKind, Range } from '@provenance/log-core';

let _g = 0;
function reset(): void {
  _g = 0;
}

function ev(kind: EventKind, payload: unknown, file?: string): IndexedEvent {
  const globalIdx = _g++;
  return {
    sessionId: 's1',
    seq: globalIdx,
    globalIdx,
    wall: '2026-01-01T00:00:00.000Z',
    t: globalIdx * 100,
    kind,
    payload,
    ...(file !== undefined ? { file } : {}),
  };
}

function rng(sl: number, sc: number, el: number, ec: number): Range {
  return { start: { line: sl, character: sc }, end: { line: el, character: ec } };
}

const selection = (file: string, range: Range, was: boolean) =>
  ev('selection.change', { path: file, range, was_selection: was }, file);
const docChange = (file: string) => ev('doc.change', { deltas: [] }, file);

describe('currentSelection', () => {
  it('returns null before the first event', () => {
    reset();
    const e = [selection('a.py', rng(0, 0, 0, 0), false)];
    expect(currentSelection(e, -1, 'a.py')).toBeNull();
  });

  it('returns null when filePath is null', () => {
    reset();
    const e = [selection('a.py', rng(1, 2, 1, 2), false)];
    expect(currentSelection(e, 0, null)).toBeNull();
  });

  it('returns the most recent selection for the file at/before the playhead', () => {
    reset();
    const e = [
      selection('a.py', rng(0, 0, 0, 0), false),
      selection('a.py', rng(3, 4, 3, 4), false),
    ];
    expect(currentSelection(e, 1, 'a.py')).toEqual({ range: rng(3, 4, 3, 4), wasSelection: false });
    // earlier playhead → earlier selection
    expect(currentSelection(e, 0, 'a.py')).toEqual({ range: rng(0, 0, 0, 0), wasSelection: false });
  });

  it('ignores selections belonging to other files', () => {
    reset();
    const e = [
      selection('a.py', rng(1, 1, 1, 1), false),
      selection('b.py', rng(9, 9, 9, 9), false),
    ];
    // active file a.py → keeps a.py's selection even though b.py's is more recent
    expect(currentSelection(e, 1, 'a.py')).toEqual({ range: rng(1, 1, 1, 1), wasSelection: false });
  });

  it('ignores non-selection events', () => {
    reset();
    const e = [selection('a.py', rng(2, 0, 2, 0), false), docChange('a.py')];
    expect(currentSelection(e, 1, 'a.py')).toEqual({ range: rng(2, 0, 2, 0), wasSelection: false });
  });

  it('passes through was_selection for a real selection', () => {
    reset();
    const e = [selection('a.py', rng(1, 0, 3, 5), true)];
    expect(currentSelection(e, 0, 'a.py')).toEqual({ range: rng(1, 0, 3, 5), wasSelection: true });
  });

  it('returns null when no selection has occurred for the file', () => {
    reset();
    const e = [docChange('a.py'), selection('b.py', rng(0, 0, 0, 0), false)];
    expect(currentSelection(e, 1, 'a.py')).toBeNull();
  });
});

describe('toMonacoRange', () => {
  it('converts 0-based LSP coordinates to 1-based Monaco coordinates', () => {
    expect(toMonacoRange(rng(0, 5, 2, 10))).toEqual({
      startLineNumber: 1,
      startColumn: 6,
      endLineNumber: 3,
      endColumn: 11,
    });
  });

  it('maps a zero-width cursor to an equal start/end Monaco range', () => {
    expect(toMonacoRange(rng(4, 2, 4, 2))).toEqual({
      startLineNumber: 5,
      startColumn: 3,
      endLineNumber: 5,
      endColumn: 3,
    });
  });
});
