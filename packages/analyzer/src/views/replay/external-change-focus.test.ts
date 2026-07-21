/**
 * external-change-focus.test.ts — the viewport target for an fs.external_change.
 */

import { describe, it, expect } from 'vitest';
import { currentExternalChange, externalChangePosition } from './external-change-focus.js';
import type { IndexedEvent } from '@provenance/analysis-core/index/event-index.js';
import type { FileReplayState } from '@provenance/analysis-core/index/reconstruct-file-provenance.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let nextIdx = 0;
function ev(kind: string, file: string | undefined, globalIdx?: number): IndexedEvent {
  const gi = globalIdx ?? nextIdx++;
  return {
    globalIdx: gi,
    sessionId: 's1',
    seq: gi,
    wall: '2026-01-01T00:00:00.000Z',
    t: gi * 1000,
    kind,
    payload: {},
    ...(file === undefined ? {} : { file }),
  } as IndexedEvent;
}

/** A replay state whose `content` has `owners` as its per-character provenance. */
function stateOf(
  content: string,
  owners: number[],
  kinds: Array<[number, string]>,
): FileReplayState {
  return {
    content,
    provenance: Uint32Array.from(owners),
    kindByGlobalIdx: new Map(kinds) as FileReplayState['kindByGlobalIdx'],
    hashBySaveSeq: new Map(),
  };
}

// ---------------------------------------------------------------------------
// currentExternalChange
// ---------------------------------------------------------------------------

describe('currentExternalChange', () => {
  it('holds the viewport from the moment the playhead reaches the event', () => {
    const events = [ev('doc.change', 'a.py', 0), ev('fs.external_change', 'a.py', 1)];
    expect(currentExternalChange(events, 1, 'a.py')?.globalIdx).toBe(1);
  });

  it('is null before the playhead reaches it', () => {
    const events = [ev('doc.change', 'a.py', 0), ev('fs.external_change', 'a.py', 1)];
    expect(currentExternalChange(events, 0, 'a.py')).toBeNull();
  });

  it('keeps holding across a doc.save emitted from the same continuation', () => {
    // The recorder emits both from one continuation, routinely at the same wall
    // clock. Counting the save would end the reveal in the tick it began.
    const events = [
      ev('fs.external_change', 'a.py', 0),
      ev('doc.save', 'a.py', 1),
      ev('session.heartbeat', undefined, 2),
    ];
    expect(currentExternalChange(events, 2, 'a.py')?.globalIdx).toBe(0);
  });

  it('hands the viewport back on the next edit', () => {
    const events = [ev('fs.external_change', 'a.py', 0), ev('doc.change', 'a.py', 1)];
    expect(currentExternalChange(events, 1, 'a.py')).toBeNull();
  });

  it('hands the viewport back on the next cursor move', () => {
    const events = [ev('fs.external_change', 'a.py', 0), ev('selection.change', 'a.py', 1)];
    expect(currentExternalChange(events, 1, 'a.py')).toBeNull();
  });

  it('ignores activity in other files', () => {
    const events = [
      ev('fs.external_change', 'a.py', 0),
      ev('doc.change', 'b.py', 1),
      ev('selection.change', 'b.py', 2),
    ];
    expect(currentExternalChange(events, 2, 'a.py')?.globalIdx).toBe(0);
  });

  it('returns the most recent external change when several stack up', () => {
    const events = [ev('fs.external_change', 'a.py', 0), ev('fs.external_change', 'a.py', 1)];
    expect(currentExternalChange(events, 1, 'a.py')?.globalIdx).toBe(1);
  });

  it('is null when no file is shown', () => {
    const events = [ev('fs.external_change', 'a.py', 0)];
    expect(currentExternalChange(events, 0, null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// externalChangePosition
// ---------------------------------------------------------------------------

describe('externalChangePosition', () => {
  it('points at the first character the event wrote, in Monaco coordinates', () => {
    // 'ab\ncd\nef' — the event owns 'e' (line 3, column 1).
    const state = stateOf('ab\ncd\nef', [7, 7, 7, 7, 7, 7, 9, 9], [[9, 'external_change']]);
    expect(externalChangePosition(state, ev('fs.external_change', 'a.py', 9))).toEqual({
      lineNumber: 3,
      column: 1,
    });
  });

  it('computes the column within the line, not the offset in the file', () => {
    // The event owns 'd' — line 2, column 2.
    const state = stateOf('ab\ncd', [7, 7, 7, 7, 9], [[9, 'external_change']]);
    expect(externalChangePosition(state, ev('fs.external_change', 'a.py', 9))).toEqual({
      lineNumber: 2,
      column: 2,
    });
  });

  it('is null for an event reconstruction classified as the editor’s own save', () => {
    // Suppressed events never reach kindByGlobalIdx, so there is nothing to show.
    const state = stateOf('abc', [7, 7, 7], [[7, 'typed']]);
    expect(externalChangePosition(state, ev('fs.external_change', 'a.py', 9))).toBeNull();
  });

  it('is null for the sentinel case, where the bytes were never recorded', () => {
    // A genuine external write over the recorder's inline cap: the event is real
    // and stays flagged, but no character references it, so its position is not
    // in the evidence. Must fall back to the caret rather than guess.
    const state = stateOf('abc', [7, 7, 7], [[9, 'external_change']]);
    expect(externalChangePosition(state, ev('fs.external_change', 'a.py', 9))).toBeNull();
  });

  it('is null when there is no event or no state', () => {
    const state = stateOf('abc', [9, 9, 9], [[9, 'external_change']]);
    expect(externalChangePosition(state, null)).toBeNull();
    expect(externalChangePosition(null, ev('fs.external_change', 'a.py', 9))).toBeNull();
  });
});
