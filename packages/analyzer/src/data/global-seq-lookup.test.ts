/**
 * Tests for buildGlobalSeqLookup.
 *
 * The behaviour under test is the one that makes multi-session submissions work:
 * a server globalIdx must resolve to the event it names regardless of which
 * session that event lives in.
 */

import { describe, it, expect } from 'vitest';
import { buildGlobalSeqLookup } from './global-seq-lookup.js';
import {
  buildIndexFromEventRows,
  type ServerEventRow,
} from '@provenance/analysis-core/index/build-index.js';

/**
 * Two sessions numbered the way the events API numbers them: `seq` is the
 * global chronological index, unique across the submission. sess-a holds 0–2,
 * sess-b holds 3–4.
 */
function rows(): ServerEventRow[] {
  return [
    {
      seq: 0,
      kind: 'session.start',
      t: 0,
      wall: '2026-01-01T00:00:00.000Z',
      session_id: 'sess-a',
      payload: { session_id: 'sess-a' },
    },
    {
      seq: 1,
      kind: 'paste',
      t: 100,
      wall: '2026-01-01T00:00:00.100Z',
      session_id: 'sess-a',
      payload: { path: 'hw1.py' },
    },
    {
      seq: 2,
      kind: 'doc.save',
      t: 200,
      wall: '2026-01-01T00:00:00.200Z',
      session_id: 'sess-a',
      payload: { path: 'hw1.py' },
    },
    {
      seq: 3,
      kind: 'session.start',
      t: 0,
      wall: '2026-01-01T04:00:00.000Z',
      session_id: 'sess-b',
      payload: { session_id: 'sess-b' },
    },
    {
      seq: 4,
      kind: 'fs.external_change',
      t: 50,
      wall: '2026-01-01T04:00:00.050Z',
      session_id: 'sess-b',
      payload: { path: 'hw1.py' },
    },
  ];
}

describe('buildGlobalSeqLookup', () => {
  it('resolves a seq to the event it names, in whichever session holds it', () => {
    const lookup = buildGlobalSeqLookup(buildIndexFromEventRows(rows()));

    expect(lookup.get(1)?.sessionId).toBe('sess-a');
    expect(lookup.get(1)?.kind).toBe('paste');
    // The point of the exercise: a seq from the *second* session resolves to
    // that session, not to the first.
    expect(lookup.get(4)?.sessionId).toBe('sess-b');
    expect(lookup.get(4)?.kind).toBe('fs.external_change');
  });

  it('covers every event exactly once', () => {
    const lookup = buildGlobalSeqLookup(buildIndexFromEventRows(rows()));
    expect(lookup.size).toBe(5);
  });

  it('returns undefined for a seq no event carries', () => {
    const lookup = buildGlobalSeqLookup(buildIndexFromEventRows(rows()));
    expect(lookup.get(999)).toBeUndefined();
  });

  it('returns an empty map for a not-yet-loaded index', () => {
    // Callers read this as "unresolved", not "the event does not exist" — the
    // difference matters because jump targets stay enabled while loading.
    expect(buildGlobalSeqLookup(null).size).toBe(0);
  });
});
