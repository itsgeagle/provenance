/**
 * jump-predicates.test.ts — unit tests for the pure jump-target predicates.
 *
 * Tests cover:
 *   - findNextPaste
 *   - findNextExternalChange
 *   - buildFlaggedGlobalIdxSet
 *   - findNextFlag
 *   - findNextFileSwitch
 *   - All countRemaining* helpers
 *
 * No React, no DOM.
 */

import { describe, it, expect } from 'vitest';
import {
  findNextPaste,
  findNextExternalChange,
  buildFlaggedGlobalIdxSet,
  findNextFlag,
  findNextFileSwitch,
  countRemainingPastes,
  countRemainingExternalChanges,
  countRemainingFlags,
  countRemainingFileSwitches,
} from './jump-predicates.js';
import type { IndexedEvent } from '../../index/event-index.js';
import type { Flag } from '../../heuristics/types.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeEvent(globalIdx: number, kind: IndexedEvent['kind'], file?: string): IndexedEvent {
  const base: IndexedEvent = {
    sessionId: 'sess1',
    seq: globalIdx,
    globalIdx,
    wall: '2026-01-01T00:00:00.000Z',
    t: globalIdx * 100,
    kind,
    payload: null,
  };
  if (file !== undefined) base.file = file;
  return base;
}

function makeFlag(supportingSeqs: string[]): Flag {
  return {
    id: `flag-${Math.random()}`,
    heuristic: 'large_paste',
    title: 'Test flag',
    severity: 'medium',
    confidence: 0.8,
    supportingSeqs,
    description: 'Test',
  };
}

// A stream with diverse kinds:
//   0: session.start
//   1: doc.change (file=hw.py)
//   2: paste (file=hw.py)
//   3: doc.change (file=hw.py)
//   4: fs.external_change (file=hw.py)
//   5: paste (file=utils.py) ← file switch!
//   6: doc.change (file=utils.py)
//   7: paste (file=hw.py)   ← file switch back!
//   8: fs.external_change (file=hw.py)

const EVENTS: IndexedEvent[] = [
  makeEvent(0, 'session.start'),
  makeEvent(1, 'doc.change', 'hw.py'),
  makeEvent(2, 'paste', 'hw.py'),
  makeEvent(3, 'doc.change', 'hw.py'),
  makeEvent(4, 'fs.external_change', 'hw.py'),
  makeEvent(5, 'paste', 'utils.py'),
  makeEvent(6, 'doc.change', 'utils.py'),
  makeEvent(7, 'paste', 'hw.py'),
  makeEvent(8, 'fs.external_change', 'hw.py'),
];

// ---------------------------------------------------------------------------
// findNextPaste
// ---------------------------------------------------------------------------

describe('findNextPaste', () => {
  it('finds the first paste after start (-1)', () => {
    expect(findNextPaste(EVENTS, -1)).toBe(2);
  });

  it('finds the next paste after globalIdx=2', () => {
    expect(findNextPaste(EVENTS, 2)).toBe(5);
  });

  it('finds the next paste after globalIdx=5', () => {
    expect(findNextPaste(EVENTS, 5)).toBe(7);
  });

  it('returns null when no more pastes', () => {
    expect(findNextPaste(EVENTS, 7)).toBeNull();
  });

  it('returns null when no pastes at all', () => {
    const noPassteEvents = EVENTS.filter((e) => e.kind !== 'paste');
    expect(findNextPaste(noPassteEvents, -1)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// findNextExternalChange
// ---------------------------------------------------------------------------

describe('findNextExternalChange', () => {
  it('finds the first external change after start (-1)', () => {
    expect(findNextExternalChange(EVENTS, -1)).toBe(4);
  });

  it('finds the next external change after globalIdx=4', () => {
    expect(findNextExternalChange(EVENTS, 4)).toBe(8);
  });

  it('returns null when no more external changes', () => {
    expect(findNextExternalChange(EVENTS, 8)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildFlaggedGlobalIdxSet + findNextFlag
// ---------------------------------------------------------------------------

describe('buildFlaggedGlobalIdxSet', () => {
  it('builds a set of globalIdx values from flag supportingSeqs', () => {
    const bySeq = new Map<string, IndexedEvent>(EVENTS.map((e) => [`${e.sessionId}:${e.seq}`, e]));
    const flags: Flag[] = [makeFlag(['sess1:2', 'sess1:4']), makeFlag(['sess1:7'])];
    const set = buildFlaggedGlobalIdxSet(flags, bySeq);
    expect(set.has(2)).toBe(true); // paste at idx 2
    expect(set.has(4)).toBe(true); // external_change at idx 4
    expect(set.has(7)).toBe(true); // paste at idx 7
    expect(set.has(1)).toBe(false); // not in any flag
  });

  it('silently skips unknown seqKeys', () => {
    const bySeq = new Map<string, IndexedEvent>(EVENTS.map((e) => [`${e.sessionId}:${e.seq}`, e]));
    const flags: Flag[] = [makeFlag(['sess1:999'])];
    const set = buildFlaggedGlobalIdxSet(flags, bySeq);
    expect(set.size).toBe(0);
  });
});

describe('findNextFlag', () => {
  const flaggedSet = new Set([2, 4, 7]);

  it('finds the first flagged event after start (-1)', () => {
    expect(findNextFlag(EVENTS, -1, flaggedSet)).toBe(2);
  });

  it('finds the next flagged event after globalIdx=2', () => {
    expect(findNextFlag(EVENTS, 2, flaggedSet)).toBe(4);
  });

  it('finds the next flagged event after globalIdx=4', () => {
    expect(findNextFlag(EVENTS, 4, flaggedSet)).toBe(7);
  });

  it('returns null when no more flagged events', () => {
    expect(findNextFlag(EVENTS, 7, flaggedSet)).toBeNull();
  });

  it('returns null when flaggedSet is empty', () => {
    expect(findNextFlag(EVENTS, -1, new Set())).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// findNextFileSwitch
// ---------------------------------------------------------------------------

describe('findNextFileSwitch', () => {
  it('detects a switch from hw.py to utils.py', () => {
    // After globalIdx=4 (hw.py), the next file switch is idx=5 (utils.py)
    expect(findNextFileSwitch(EVENTS, 4)).toBe(5);
  });

  it('detects a switch from utils.py to hw.py', () => {
    // After globalIdx=6 (utils.py), the next file switch is idx=7 (hw.py)
    expect(findNextFileSwitch(EVENTS, 6)).toBe(7);
  });

  it('finds the first file event when current position has no file context', () => {
    // At -1 (before any event), currentFile is undefined.
    // First event with a file is idx=1 (hw.py) → this IS a file switch
    // (undefined → hw.py counts as a file switch).
    expect(findNextFileSwitch(EVENTS, -1)).toBe(1);
  });

  it('returns null when no file switch after current position', () => {
    // After idx=8 (hw.py), there are no more events at all
    expect(findNextFileSwitch(EVENTS, 8)).toBeNull();
  });

  it('returns null when remaining events all have the same file', () => {
    // After idx=7 (hw.py), idx=8 is also hw.py — no switch
    expect(findNextFileSwitch(EVENTS, 7)).toBeNull();
  });

  it('ignores events without a file attribute', () => {
    // idx=0 is session.start (no file); idx=1 is doc.change (file=hw.py)
    // From idx=0, next file switch should be idx=1 (undefined → hw.py)
    expect(findNextFileSwitch(EVENTS, 0)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// countRemaining*
// ---------------------------------------------------------------------------

describe('countRemainingPastes', () => {
  it('counts all pastes when at start', () => {
    // pastes at idx 2, 5, 7
    expect(countRemainingPastes(EVENTS, -1)).toBe(3);
  });

  it('counts pastes after current position', () => {
    expect(countRemainingPastes(EVENTS, 2)).toBe(2); // idx 5 and 7
    expect(countRemainingPastes(EVENTS, 5)).toBe(1); // idx 7
    expect(countRemainingPastes(EVENTS, 7)).toBe(0);
  });
});

describe('countRemainingExternalChanges', () => {
  it('counts all external changes when at start', () => {
    expect(countRemainingExternalChanges(EVENTS, -1)).toBe(2);
  });

  it('counts external changes after current position', () => {
    expect(countRemainingExternalChanges(EVENTS, 4)).toBe(1);
    expect(countRemainingExternalChanges(EVENTS, 8)).toBe(0);
  });
});

describe('countRemainingFlags', () => {
  const flaggedSet = new Set([2, 4, 7]);

  it('counts all flagged events when at start', () => {
    expect(countRemainingFlags(EVENTS, -1, flaggedSet)).toBe(3);
  });

  it('counts flagged events after current position', () => {
    expect(countRemainingFlags(EVENTS, 2, flaggedSet)).toBe(2);
    expect(countRemainingFlags(EVENTS, 7, flaggedSet)).toBe(0);
  });
});

describe('countRemainingFileSwitches', () => {
  it('counts switches when starting before any file event', () => {
    // From -1: idx1 (→hw.py), idx5 (→utils.py), idx7 (→hw.py) = 3 switches
    expect(countRemainingFileSwitches(EVENTS, -1)).toBe(3);
  });

  it('counts switches after current position', () => {
    // From idx=2 (hw.py): idx5 (→utils.py), idx7 (→hw.py) = 2 switches
    expect(countRemainingFileSwitches(EVENTS, 2)).toBe(2);
  });

  it('returns 0 when no more switches', () => {
    // From idx=7 (hw.py): idx8 is also hw.py = 0 switches
    expect(countRemainingFileSwitches(EVENTS, 7)).toBe(0);
  });
});
