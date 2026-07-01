/**
 * Tests for provenance-utils.ts (Phase 12).
 */

import { describe, it, expect } from 'vitest';
import { linesWithProvenance, colorForGlobalIdx, lineLastTouchedAt } from './provenance-utils.js';
import type { FileReplayState } from './reconstruct-file-provenance.js';

function makeState(
  content: string,
  provenance: number[],
  kindEntries: Array<[number, 'typed' | 'paste' | 'external_change']> = [],
): FileReplayState {
  return {
    content,
    provenance: Uint32Array.from(provenance),
    kindByGlobalIdx: new Map(kindEntries),
    hashBySaveSeq: new Map(),
  };
}

// ---------------------------------------------------------------------------
// linesWithProvenance
// ---------------------------------------------------------------------------

describe('linesWithProvenance', () => {
  it('returns one entry for an empty buffer', () => {
    const out = linesWithProvenance(makeState('', []));
    expect(out).toEqual([{ text: '', provenance: [] }]);
  });

  it('returns one entry for a single line without newline', () => {
    const out = linesWithProvenance(makeState('abc', [1, 1, 2]));
    expect(out).toEqual([{ text: 'abc', provenance: [1, 1, 2] }]);
  });

  it('splits on newlines and projects provenance correctly', () => {
    // content: "ab\ncde\nf", provenance lines up 1:1
    const out = linesWithProvenance(makeState('ab\ncde\nf', [1, 1, 2, 3, 3, 3, 4, 5]));
    // \n at index 2 and index 6 are excluded from line text
    expect(out).toEqual([
      { text: 'ab', provenance: [1, 1] },
      { text: 'cde', provenance: [3, 3, 3] },
      { text: 'f', provenance: [5] },
    ]);
  });

  it('handles trailing newline (final empty line)', () => {
    const out = linesWithProvenance(makeState('ab\n', [1, 1, 9]));
    expect(out).toEqual([
      { text: 'ab', provenance: [1, 1] },
      { text: '', provenance: [] },
    ]);
  });
});

// ---------------------------------------------------------------------------
// colorForGlobalIdx
// ---------------------------------------------------------------------------

describe('colorForGlobalIdx', () => {
  it('returns the kind registered in kindByGlobalIdx', () => {
    const state = makeState(
      'abc',
      [1, 1, 2],
      [
        [1, 'typed'],
        [2, 'paste'],
      ],
    );
    expect(colorForGlobalIdx(state, 1)).toBe('typed');
    expect(colorForGlobalIdx(state, 2)).toBe('paste');
  });

  it('returns null for an unknown globalIdx', () => {
    const state = makeState('abc', [1, 1, 2], [[1, 'typed']]);
    expect(colorForGlobalIdx(state, 999)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// lineLastTouchedAt
// ---------------------------------------------------------------------------

describe('lineLastTouchedAt', () => {
  it('returns the max globalIdx on the requested line', () => {
    // content: "ab\ncde", line 0 → [1,1], line 1 → [3,4,2]
    const state = makeState('ab\ncde', [1, 1, 3, 4, 2]);
    expect(lineLastTouchedAt(state, 0)).toBe(1);
    expect(lineLastTouchedAt(state, 1)).toBe(4);
  });

  it('returns null for an empty line', () => {
    // content: "ab\n" → line 1 is empty
    const state = makeState('ab\n', [1, 1, 9]);
    expect(lineLastTouchedAt(state, 1)).toBeNull();
  });

  it('returns null for an out-of-range line', () => {
    const state = makeState('ab', [1, 1]);
    expect(lineLastTouchedAt(state, 7)).toBeNull();
  });

  it('returns null for empty content', () => {
    const state = makeState('', []);
    // line 0 exists but is empty → null
    expect(lineLastTouchedAt(state, 0)).toBeNull();
  });
});
