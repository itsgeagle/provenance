/**
 * Tests for the FlagView projections.
 *
 * The load-bearing behaviour is that the server projection resolves supporting
 * events by globalIdx alone. `session_id` is '' for exactly the flags whose
 * evidence spans sessions, so anything that keys off it is wrong on the
 * submissions that matter most.
 */

import { describe, it, expect } from 'vitest';
import {
  toFlagViewFromLocal,
  toFlagViewFromRow,
  groupSupportingBySession,
  countSessionsSpanned,
  pickFlagByHeuristic,
  type FlagView,
  type SupportingRef,
} from './flag-view.js';
import { buildGlobalSeqLookup } from '../../data/global-seq-lookup.js';
import {
  buildIndexFromEventRows,
  type ServerEventRow,
} from '@provenance/analysis-core/index/build-index.js';
import type { IndexedEvent } from '@provenance/analysis-core/index/event-index.js';
import type { Flag } from '@provenance/analysis-core/heuristics/types.js';
import type { FlagRow } from '@provenance/shared/api-schemas';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Two sessions, globally numbered as the events API numbers them. */
function serverRows(): ServerEventRow[] {
  return [
    {
      seq: 0,
      session_id: 'sess-a',
      t: 0,
      wall: '2026-01-01T00:00:00.000Z',
      kind: 'session.start',
      payload: {},
    },
    {
      seq: 1,
      session_id: 'sess-a',
      t: 100,
      wall: '2026-01-01T00:00:01.000Z',
      kind: 'paste',
      payload: { path: 'hw1.py' },
    },
    {
      seq: 2,
      session_id: 'sess-b',
      t: 0,
      wall: '2026-01-02T00:00:00.000Z',
      kind: 'session.start',
      payload: {},
    },
    {
      seq: 3,
      session_id: 'sess-b',
      t: 100,
      wall: '2026-01-02T00:00:01.000Z',
      kind: 'fs.external_change',
      payload: { path: 'hw1.py' },
    },
  ];
}

function flagRow(overrides: Partial<FlagRow> = {}): FlagRow {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    heuristic_id: 'external_edits',
    severity: 'high',
    confidence: 0.9,
    score_contribution: 4.5,
    title: 'External edit in hw1.py',
    description: 'A file changed on disk between sessions.',
    detail: { path: 'hw1.py' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// toFlagViewFromRow
// ---------------------------------------------------------------------------

describe('toFlagViewFromRow', () => {
  it('resolves supporting seqs that span sessions', () => {
    const bySeq = buildGlobalSeqLookup(buildIndexFromEventRows(serverRows()));
    // session_id is '' — the cross-session case that used to break.
    const view = toFlagViewFromRow(flagRow({ supporting_seqs: [1, 3], session_id: '' }), bySeq);

    expect(view.supporting.map((r) => r.event?.sessionId)).toEqual(['sess-a', 'sess-b']);
    expect(view.supporting.map((r) => r.timelineSeq)).toEqual(['sess-a:1', 'sess-b:3']);
  });

  it('keeps unresolved seqs navigable, with the bare global seq as the link', () => {
    // Index not loaded: refs still carry globalIdx, and timelineSeq falls back
    // to the bare number — which TimelineInner accepts.
    const view = toFlagViewFromRow(
      flagRow({ supporting_seqs: [1, 3] }),
      buildGlobalSeqLookup(null),
    );

    expect(view.supporting).toHaveLength(2);
    expect(view.supporting.map((r) => r.event)).toEqual([null, null]);
    expect(view.supporting.map((r) => r.globalIdx)).toEqual([1, 3]);
    expect(view.supporting.map((r) => r.timelineSeq)).toEqual(['1', '3']);
  });

  it('carries persisted prose through', () => {
    const bySeq = buildGlobalSeqLookup(buildIndexFromEventRows(serverRows()));
    const view = toFlagViewFromRow(flagRow({ supporting_seqs: [1] }), bySeq);
    expect(view.title).toBe('External edit in hw1.py');
    expect(view.description).toBe('A file changed on disk between sessions.');
  });

  it('falls back to the heuristic id when prose was never persisted', () => {
    const bySeq = buildGlobalSeqLookup(buildIndexFromEventRows(serverRows()));
    // Rows written before server migration 0020 carry '' rather than absent.
    const empty = toFlagViewFromRow(flagRow({ title: '', description: '' }), bySeq);
    expect(empty.title).toBe('external_edits');
    expect(empty.description).toBe('');

    const absent = toFlagViewFromRow(flagRow({ title: undefined, description: undefined }), bySeq);
    expect(absent.title).toBe('external_edits');
    expect(absent.description).toBe('');
  });

  it('treats a non-object detail as no detail', () => {
    const bySeq = buildGlobalSeqLookup(buildIndexFromEventRows(serverRows()));
    expect(toFlagViewFromRow(flagRow({ detail: null }), bySeq).detail).toBeUndefined();
  });

  it('handles a flag with no supporting seqs at all', () => {
    const bySeq = buildGlobalSeqLookup(buildIndexFromEventRows(serverRows()));
    expect(toFlagViewFromRow(flagRow({ supporting_seqs: [] }), bySeq).supporting).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// toFlagViewFromLocal
// ---------------------------------------------------------------------------

describe('toFlagViewFromLocal', () => {
  const flag: Flag = {
    id: 'large_paste-sess-a:1-0',
    heuristic: 'large_paste',
    title: 'Large paste in hw1.py',
    severity: 'medium',
    confidence: 0.8,
    supportingSeqs: ['sess-a:1'],
    description: 'A paste of 250 characters.',
    detail: { path: 'hw1.py' },
  };

  it('resolves seqKeys through index.bySeq and reuses them as the deep link', () => {
    const index = buildIndexFromEventRows(serverRows());
    const view = toFlagViewFromLocal(flag, index);

    expect(view.supporting).toHaveLength(1);
    expect(view.supporting[0]!.timelineSeq).toBe('sess-a:1');
    expect(view.supporting[0]!.event?.sessionId).toBe('sess-a');
    expect(view.supporting[0]!.globalIdx).toBe(1);
  });

  it('yields unresolved refs when no index is loaded', () => {
    const view = toFlagViewFromLocal(flag, null);
    expect(view.supporting[0]!.event).toBeNull();
    expect(view.supporting[0]!.globalIdx).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

describe('groupSupportingBySession', () => {
  const ref = (id: string, sessionId: string | null): SupportingRef => ({
    id,
    globalIdx: Number(id),
    timelineSeq: id,
    event: sessionId === null ? null : ({ sessionId } as IndexedEvent),
  });

  it('groups by session, preserving arrival order within a group', () => {
    const groups = groupSupportingBySession([
      ref('1', 'sess-a'),
      ref('3', 'sess-b'),
      ref('2', 'sess-a'),
    ]);

    expect(groups.map((g) => g.sessionId)).toEqual(['sess-a', 'sess-b']);
    expect(groups[0]!.refs.map((r) => r.id)).toEqual(['1', '2']);
    expect(groups[1]!.refs.map((r) => r.id)).toEqual(['3']);
  });

  it('collects unresolved refs into a single trailing group', () => {
    // They carry no timestamp to order by, so they sort last rather than
    // interleaving unpredictably.
    const groups = groupSupportingBySession([ref('9', null), ref('1', 'sess-a'), ref('8', null)]);

    expect(groups.map((g) => g.sessionId)).toEqual(['sess-a', null]);
    expect(groups[1]!.refs.map((r) => r.id)).toEqual(['9', '8']);
  });

  it('returns nothing for no refs', () => {
    expect(groupSupportingBySession([])).toEqual([]);
  });
});

describe('countSessionsSpanned', () => {
  const ref = (sessionId: string | null): SupportingRef => ({
    id: sessionId ?? 'x',
    globalIdx: 0,
    timelineSeq: '0',
    event: sessionId === null ? null : ({ sessionId } as IndexedEvent),
  });

  it('counts distinct sessions among resolved refs', () => {
    expect(countSessionsSpanned([ref('a'), ref('b'), ref('a')])).toBe(2);
  });

  it('ignores unresolved refs', () => {
    expect(countSessionsSpanned([ref('a'), ref(null)])).toBe(1);
  });
});

describe('pickFlagByHeuristic', () => {
  const flag = (id: string, heuristic: string, severity: FlagView['severity']): FlagView => ({
    id,
    heuristic,
    title: id,
    description: '',
    severity,
    confidence: 1,
    supporting: [],
  });

  it('returns the id of the single flag matching the heuristic', () => {
    const flags = [flag('a', 'large_paste', 'high'), flag('b', 'external_edits', 'low')];
    expect(pickFlagByHeuristic(flags, 'external_edits')).toBe('b');
  });

  it('picks the highest-severity flag when several share the heuristic', () => {
    const flags = [
      flag('low', 'dup', 'low'),
      flag('high', 'dup', 'high'),
      flag('med', 'dup', 'medium'),
    ];
    expect(pickFlagByHeuristic(flags, 'dup')).toBe('high');
  });

  it('breaks a severity tie by keeping the first in order', () => {
    const flags = [flag('first', 'dup', 'high'), flag('second', 'dup', 'high')];
    expect(pickFlagByHeuristic(flags, 'dup')).toBe('first');
  });

  it('returns null when no flag matches', () => {
    expect(pickFlagByHeuristic([flag('a', 'large_paste', 'high')], 'nope')).toBeNull();
  });
});
