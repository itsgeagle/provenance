/**
 * replay-decoration-utils.test.ts — unit tests for the pure Phase 14 helpers.
 *
 * Tests:
 *  runsFromProvenance:
 *   1. Empty file → no runs.
 *   2. All-typed → no runs.
 *   3. Single paste span → one run.
 *   4. Paste then typed → one paste run stops at typed boundary.
 *   5. Typed then paste → run starts at paste.
 *   6. Two separate paste spans → two runs.
 *   7. external_change → sentinel invariant (file cleared; zero-length content).
 *   8. Multi-line paste → run spans lines correctly.
 *
 *  hoverContentFor:
 *   9. Valid offset returns formatted string with t, kind, seq.
 *  10. Paste event hover shows kind=paste.
 *  11. Out-of-range offset → null.
 *  12. Empty provenance → null.
 */

import { describe, it, expect } from 'vitest';
import { runsFromProvenance, hoverContentFor } from './replay-decoration-utils.js';
import type { FileReplayState } from '../../index/reconstruct-file-provenance.js';
import type { IndexedEvent } from '../../index/event-index.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeState(
  content: string,
  provenance: number[],
  kindByGlobalIdx: Map<number, 'typed' | 'paste' | 'external_change' | 'preexisting'>,
): FileReplayState {
  return {
    content,
    provenance: Uint32Array.from(provenance),
    kindByGlobalIdx,
    hashBySaveSeq: new Map(),
  };
}

function makeEvent(globalIdx: number, kind: string, seq: number, t: number): IndexedEvent {
  return {
    sessionId: 'sess1',
    seq,
    globalIdx,
    wall: '2026-01-01T00:00:00.000Z',
    t,
    kind: kind as IndexedEvent['kind'],
    payload: null,
  };
}

// ---------------------------------------------------------------------------
// runsFromProvenance
// ---------------------------------------------------------------------------

describe('runsFromProvenance', () => {
  it('empty file → no runs', () => {
    const state = makeState('', [], new Map());
    expect(runsFromProvenance(state)).toEqual([]);
  });

  it('all typed → no runs', () => {
    // content "abc" all typed via globalIdx 0
    const state = makeState('abc', [0, 0, 0], new Map([[0, 'typed']]));
    expect(runsFromProvenance(state)).toEqual([]);
  });

  it('single paste span → one run covering all chars', () => {
    const state = makeState('abc', [1, 1, 1], new Map([[1, 'paste']]));
    const runs = runsFromProvenance(state);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      kind: 'paste',
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 4, // exclusive: after 'c' (col 3) → 4
    });
  });

  it('paste then typed → run stops at typed boundary', () => {
    // "ab cd" — 'ab' paste, ' cd' typed (globalIdx 0 paste, 1 typed)
    const state = makeState(
      'ab cd',
      [0, 0, 1, 1, 1],
      new Map([
        [0, 'paste'],
        [1, 'typed'],
      ]),
    );
    const runs = runsFromProvenance(state);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      kind: 'paste',
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 3, // exclusive: after 'b' (col 2) → 3
    });
  });

  it('typed then paste → run starts at paste', () => {
    // "ab cd" — 'ab ' typed, 'cd' paste
    const state = makeState(
      'ab cd',
      [0, 0, 0, 1, 1],
      new Map([
        [0, 'typed'],
        [1, 'paste'],
      ]),
    );
    const runs = runsFromProvenance(state);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      kind: 'paste',
      startLineNumber: 1,
      startColumn: 4, // 'd' starts at column 4 (1-based)
      endLineNumber: 1,
      endColumn: 6, // after 'd' (col 5) → 6
    });
  });

  it('two separate paste spans → two runs', () => {
    // "aXbYc" — 'X'(gi=1 paste), 'Y'(gi=2 paste), rest typed(gi=0)
    const state = makeState(
      'aXbYc',
      [0, 1, 0, 2, 0],
      new Map([
        [0, 'typed'],
        [1, 'paste'],
        [2, 'paste'],
      ]),
    );
    const runs = runsFromProvenance(state);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ kind: 'paste', startColumn: 2, endColumn: 3 });
    expect(runs[1]).toMatchObject({ kind: 'paste', startColumn: 4, endColumn: 5 });
  });

  it('external_change sentinel — content is empty after clear', () => {
    // Pre-v1.3 bundle: fs.external_change had no new_content, so content
    // and provenance are cleared. The state has an external_change entry in
    // kindByGlobalIdx but the content/provenance are empty.
    const state = makeState('', [], new Map([[5, 'external_change']]));
    expect(runsFromProvenance(state)).toEqual([]);
  });

  it('external_change reseeded — paints a run over the reseeded content (recorder v1.3+)', () => {
    // Recorder v1.3+: fs.external_change carries new_content, so the
    // reconstructor reseeds and attributes every char to the event's
    // globalIdx with kind 'external_change'. The decoration painter should
    // emit one run covering the whole reseeded region.
    const state = makeState(
      'def x(): return 1',
      [7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7],
      new Map([[7, 'external_change']]),
    );
    const runs = runsFromProvenance(state);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      kind: 'external_change',
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 18,
    });
  });

  it('multi-line paste → run spans lines correctly', () => {
    // "ab\ncd" all paste (gi=1). Lines: ["ab", "cd"]
    const state = makeState('ab\ncd', [1, 1, 1, 1, 1], new Map([[1, 'paste']]));
    // Note: '\n' at index 2 is in provenance (gi=1). linesWithProvenance
    // splits on '\n' and does NOT include the newline in the line's provenance.
    // So line 0 = "ab" (prov [1,1]), line 1 = "cd" (prov [1,1]).
    const runs = runsFromProvenance(state);
    // The run for line 1 (chars 'a','b') closes at end-of-loop and starts
    // again for line 2 ('c','d') — but since they share the same kind, only
    // one run should be emitted that starts at line 1 col 1.
    // Since kind doesn't change between lines, we get one run.
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      kind: 'paste',
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 2,
      endColumn: 3, // after 'd' on line 2 (col 2) → 3
    });
  });

  it('mixed typed/paste across two lines', () => {
    // Line 1: "aB" — 'a' typed(gi=0), 'B' paste(gi=1)
    // Line 2: "Cd" — 'C' paste(gi=1), 'd' typed(gi=0)
    // 'B' and 'C' share gi=1 (same paste kind) → ONE run spans both lines.
    const state = makeState(
      'aB\nCd',
      [0, 1, 1, 1, 0],
      new Map([
        [0, 'typed'],
        [1, 'paste'],
      ]),
    );
    const runs = runsFromProvenance(state);
    // The paste run starts at (line1, col2) for 'B', continues to (line2, col1) for 'C',
    // closes when 'd' (typed) is encountered at col 2 on line 2.
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      kind: 'paste',
      startLineNumber: 1,
      startColumn: 2,
      endLineNumber: 2,
      endColumn: 2,
    });
  });
});

// Refined multi-line test (separate from mixed above which has a logic note):
describe('runsFromProvenance — cross-line continuation', () => {
  it('paste run continues across line boundary without restart', () => {
    // "aB\nCd" where B and C are same paste event (gi=1)
    const state = makeState(
      'aB\nCd',
      [0, 1, 1, 1, 0],
      new Map([
        [0, 'typed'],
        [1, 'paste'],
      ]),
    );
    const runs = runsFromProvenance(state);
    // 'a' typed, 'B' paste → open paste at (1,2).
    // '\n' is at provenance index 2 (gi=1, paste): linesWithProvenance ignores '\n' chars,
    // so we never see gi for index 2 in any line's provenance. Provenance at index 2 = 1.
    // Line 2 chars: 'C'(gi=1,paste), 'd'(gi=0,typed).
    // 'C' continues paste run; 'd' typed → close paste at (2,2).
    // Then 'd' typed, no close needed at end of content.
    // Result: one paste run from (1,2) to (2,2) — but wait: our test above says 2.
    // Let me count precisely: the provenance array [0,1,1,1,0] maps to:
    //   index 0 → 'a' on line 1, gi=0 typed
    //   index 1 → 'B' on line 1, gi=1 paste
    //   index 2 → '\n' — BUT linesWithProvenance splits on \n and does NOT include
    //             the newline char in any line's provenance. So this gi=1 entry is
    //             not visited by the loop. This is the crucial edge case.
    //   index 3 → 'C' on line 2, gi=1 paste
    //   index 4 → 'd' on line 2, gi=0 typed
    // Loop sees: line1=['a'(0,typed),'B'(1,paste)], line2=['C'(1,paste),'d'(0,typed)]
    // 'a': typed, currentKind=null → nothing
    // 'B': paste ≠ null → open paste at (1,2)
    // end line 1: currentKind=paste (still open)
    // 'C': paste === currentKind → continue
    // 'd': typed → close paste at endLine=2, endCol=2 (col of 'd' = 2, endColumn exclusive = 2)
    // end loop: currentKind=null
    // Then at end: no open run.
    // BUT: 'B' is at col 2, endColumn should be the column AFTER 'd'? No: we close
    // when we see 'd' (typed), not at 'd'. So endLine=2, endCol=charIdx+1=2 (charIdx=1 for 'd').
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      kind: 'paste',
      startLineNumber: 1,
      startColumn: 2,
      endLineNumber: 2,
      endColumn: 2,
    });
  });
});

// ---------------------------------------------------------------------------
// hoverContentFor
// ---------------------------------------------------------------------------

describe('hoverContentFor', () => {
  const events: IndexedEvent[] = [
    makeEvent(0, 'doc.change', 0, 0),
    makeEvent(1, 'paste', 3, 500),
    makeEvent(2, 'doc.change', 4, 1200),
  ];

  it('returns formatted string for a typed character', () => {
    // offset 0 → provenance[0] = gi=0, kind=typed, event at gi=0: t=0, seq=0
    const state = makeState('abc', [0, 0, 0], new Map([[0, 'typed']]));
    const result = hoverContentFor(0, state, events);
    expect(result).toBe('Last modified at t=0ms, kind=typed, seq=#0');
  });

  it('returns formatted string for a paste character', () => {
    // offset 1 → gi=1, kind=paste, event: t=500ms, seq=3
    const state = makeState(
      'ab',
      [0, 1],
      new Map([
        [0, 'typed'],
        [1, 'paste'],
      ]),
    );
    const result = hoverContentFor(1, state, events);
    expect(result).toBe('Last modified at t=500ms, kind=paste, seq=#3');
  });

  it('out-of-range offset → null', () => {
    const state = makeState('a', [0], new Map([[0, 'typed']]));
    expect(hoverContentFor(5, state, events)).toBeNull();
    expect(hoverContentFor(-1, state, events)).toBeNull();
  });

  it('empty provenance → null', () => {
    const state = makeState('', [], new Map());
    expect(hoverContentFor(0, state, events)).toBeNull();
  });

  it('unknown globalIdx (no matching event) → null', () => {
    // provenance references gi=99 but events array only has 0,1,2
    const state = makeState('x', [99], new Map([[99, 'typed']]));
    expect(hoverContentFor(0, state, events)).toBeNull();
  });

  it('returns formatted string for a preexisting character', () => {
    // offset 0 → provenance[0] = gi=3 (doc.open), kind=preexisting
    // Create an event with kind=doc.open and t=1500
    const preexistingEvent = makeEvent(3, 'doc.open', 5, 1500);
    const allEvents = [...events, preexistingEvent];
    const state = makeState(
      'preexisting text',
      Array.from({ length: 'preexisting text'.length }, () => 3),
      new Map([[3, 'preexisting']]),
    );
    const result = hoverContentFor(0, state, allEvents);
    expect(result).toBe('Last modified at t=1500ms, kind=preexisting, seq=#5');
  });
});
