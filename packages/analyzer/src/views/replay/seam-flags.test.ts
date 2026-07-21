/**
 * Tests for seam-flags — mapping inter_session_external_change flags onto the
 * session boundary they describe.
 */

import { describe, it, expect } from 'vitest';
import { buildFlaggedSeamIdxs, INTER_SESSION_EXTERNAL_CHANGE } from './seam-flags.js';
import type { Seam } from './bundle-clock.js';
import type { Flag } from '@provenance/analysis-core/heuristics/types.js';
import type { IndexedEvent } from '@provenance/analysis-core/index/event-index.js';

function ev(globalIdx: number, sessionId: string, seq: number): IndexedEvent {
  return {
    globalIdx,
    sessionId,
    seq,
    wall: '2026-01-01T00:00:00.000Z',
    t: 0,
    kind: 'doc.open',
    payload: null,
  };
}

function seam(atGlobalIdx: number, prev: string, next: string): Seam {
  return {
    atGlobalIdx,
    prevSessionId: prev,
    nextSessionId: next,
    realGapMs: 60_000,
    collapsedGapMs: 5_000,
  };
}

function flag(heuristic: string, supportingSeqs: string[]): Flag {
  return {
    id: `${heuristic}-x`,
    heuristic,
    title: heuristic,
    severity: 'high',
    confidence: 0.85,
    supportingSeqs,
    description: '',
  };
}

// sess-b starts at globalIdx 5; its first doc.open is seq 0.
const BY_SEQ = new Map<string, IndexedEvent>([
  ['sess-a:0', ev(0, 'sess-a', 0)],
  ['sess-b:0', ev(5, 'sess-b', 0)],
  ['sess-c:0', ev(9, 'sess-c', 0)],
]);

const SEAMS: Seam[] = [seam(5, 'sess-a', 'sess-b'), seam(9, 'sess-b', 'sess-c')];

describe('buildFlaggedSeamIdxs', () => {
  it('flags the seam whose next session carries the supporting event', () => {
    const flags = [flag(INTER_SESSION_EXTERNAL_CHANGE, ['sess-b:0'])];
    expect(buildFlaggedSeamIdxs(SEAMS, flags, BY_SEQ)).toEqual(new Set([5]));
  });

  it('flags the correct seam when several exist', () => {
    const flags = [flag(INTER_SESSION_EXTERNAL_CHANGE, ['sess-c:0'])];
    expect(buildFlaggedSeamIdxs(SEAMS, flags, BY_SEQ)).toEqual(new Set([9]));
  });

  it('flags multiple seams independently', () => {
    const flags = [
      flag(INTER_SESSION_EXTERNAL_CHANGE, ['sess-b:0']),
      flag(INTER_SESSION_EXTERNAL_CHANGE, ['sess-c:0']),
    ];
    expect(buildFlaggedSeamIdxs(SEAMS, flags, BY_SEQ)).toEqual(new Set([5, 9]));
  });

  it('ignores flags from other heuristics', () => {
    const flags = [flag('large_paste', ['sess-b:0'])];
    expect(buildFlaggedSeamIdxs(SEAMS, flags, BY_SEQ)).toEqual(new Set());
  });

  it('returns an empty set when there are no seams', () => {
    const flags = [flag(INTER_SESSION_EXTERNAL_CHANGE, ['sess-b:0'])];
    expect(buildFlaggedSeamIdxs([], flags, BY_SEQ)).toEqual(new Set());
  });

  it('returns an empty set when there are no flags', () => {
    expect(buildFlaggedSeamIdxs(SEAMS, [], BY_SEQ)).toEqual(new Set());
  });

  it('ignores a supporting seq absent from bySeq', () => {
    const flags = [flag(INTER_SESSION_EXTERNAL_CHANGE, ['sess-zz:99'])];
    expect(buildFlaggedSeamIdxs(SEAMS, flags, BY_SEQ)).toEqual(new Set());
  });

  it('ignores a supporting event that is not in any seam’s next session', () => {
    // sess-a is the FIRST session, so it is no seam's nextSessionId.
    const flags = [flag(INTER_SESSION_EXTERNAL_CHANGE, ['sess-a:0'])];
    expect(buildFlaggedSeamIdxs(SEAMS, flags, BY_SEQ)).toEqual(new Set());
  });
});
