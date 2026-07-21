/**
 * Tests for file-recency — "when was this file last edited, relative to the
 * playhead?" for the replay tab strip.
 */

import { describe, it, expect } from 'vitest';
import { computeFileRecency, formatRecency } from './file-recency.js';
import type { EventIndex, IndexedEvent } from '@provenance/analysis-core/index/event-index.js';
import type { EventKind } from '@provenance/log-core';

function ev(globalIdx: number, sessionId: string, file: string, wall: string): IndexedEvent {
  return {
    globalIdx,
    sessionId,
    seq: globalIdx,
    wall,
    t: globalIdx * 100,
    kind: 'doc.change',
    payload: null,
    file,
  };
}

function buildIndex(events: IndexedEvent[]): EventIndex {
  const bySeq = new Map<string, IndexedEvent>();
  const byKind = new Map<EventKind, IndexedEvent[]>();
  const byFile = new Map<string, IndexedEvent[]>();
  const bySessionId = new Map<string, IndexedEvent[]>();
  const ordered = [...events].sort((a, b) => a.globalIdx - b.globalIdx);
  for (const e of ordered) {
    bySeq.set(`${e.sessionId}:${e.seq}`, e);
    byKind.set(e.kind, [...(byKind.get(e.kind) ?? []), e]);
    if (e.file) byFile.set(e.file, [...(byFile.get(e.file) ?? []), e]);
    bySessionId.set(e.sessionId, [...(bySessionId.get(e.sessionId) ?? []), e]);
  }
  return { bySeq, byKind, byFile, bySessionId, ordered };
}

/**
 * sess-a: hw1.py at 0 and 1
 * sess-b: hw2.py at 2
 * sess-c: hw3.py at 3, then hw1.py again at 4
 */
const INDEX = buildIndex([
  ev(0, 'sess-a', 'hw1.py', '2026-01-01T00:00:00.000Z'),
  ev(1, 'sess-a', 'hw1.py', '2026-01-01T00:00:00.200Z'),
  ev(2, 'sess-b', 'hw2.py', '2026-01-02T00:00:00.000Z'),
  ev(3, 'sess-c', 'hw3.py', '2026-01-03T00:00:00.000Z'),
  ev(4, 'sess-c', 'hw1.py', '2026-01-03T00:02:00.000Z'),
]);

describe('computeFileRecency', () => {
  it('returns untouched when the file has no event at or before the playhead', () => {
    // Playhead at 0; hw2.py's first event is at globalIdx 2.
    expect(computeFileRecency(INDEX, 'hw2.py', 0, 'sess-a')).toEqual({ state: 'untouched' });
  });

  it('returns untouched for a file with no events at all', () => {
    expect(computeFileRecency(INDEX, 'nope.py', 4, 'sess-c')).toEqual({ state: 'untouched' });
  });

  it('returns untouched before the first event (playhead -1)', () => {
    expect(computeFileRecency(INDEX, 'hw1.py', -1, 'sess-a')).toEqual({ state: 'untouched' });
  });

  it('returns current-session with the wall delta for a same-session edit', () => {
    // Playhead at 1 (hw1.py, 00:00.200); last hw1.py edit is that same event.
    expect(computeFileRecency(INDEX, 'hw1.py', 1, 'sess-a')).toEqual({
      state: 'current-session',
      agoMs: 0,
    });
  });

  it('measures the wall delta from the playhead event, not from now', () => {
    // Playhead at 4 (sess-c, 00:02:00); hw3.py last edited at 3 (00:00:00).
    expect(computeFileRecency(INDEX, 'hw3.py', 4, 'sess-c')).toEqual({
      state: 'current-session',
      agoMs: 120_000,
    });
  });

  it('returns earlier-session with the session distance', () => {
    // Playhead in sess-c; hw1.py's last edit at or before globalIdx 3 is in sess-a.
    expect(computeFileRecency(INDEX, 'hw1.py', 3, 'sess-c')).toEqual({
      state: 'earlier-session',
      sessionsAgo: 2,
    });
  });

  it('counts one session back for the immediately previous session', () => {
    // Playhead in sess-c; hw2.py was last edited in sess-b.
    expect(computeFileRecency(INDEX, 'hw2.py', 3, 'sess-c')).toEqual({
      state: 'earlier-session',
      sessionsAgo: 1,
    });
  });

  it('resolves the last edit AT OR BEFORE the playhead, not the file’s final edit', () => {
    // hw1.py is edited at 0, 1 and again at 4. At playhead 2 the answer must be
    // event 1 (sess-a), not event 4 (sess-c).
    expect(computeFileRecency(INDEX, 'hw1.py', 2, 'sess-b')).toEqual({
      state: 'earlier-session',
      sessionsAgo: 1,
    });
  });

  it('flips back to current-session once the playhead reaches the later edit', () => {
    expect(computeFileRecency(INDEX, 'hw1.py', 4, 'sess-c')).toEqual({
      state: 'current-session',
      agoMs: 0,
    });
  });

  it('floors a negative wall delta at zero', () => {
    const skewed = buildIndex([
      ev(0, 'sess-a', 'hw1.py', '2026-01-01T05:00:00.000Z'),
      ev(1, 'sess-a', 'hw2.py', '2026-01-01T04:00:00.000Z'), // earlier wall
    ]);
    expect(computeFileRecency(skewed, 'hw1.py', 1, 'sess-a')).toEqual({
      state: 'current-session',
      agoMs: 0,
    });
  });
});

describe('formatRecency', () => {
  it('returns null for untouched', () => {
    expect(formatRecency({ state: 'untouched' })).toBeNull();
  });

  it('formats a just-edited file as "now"', () => {
    expect(formatRecency({ state: 'current-session', agoMs: 0 })).toBe('now');
  });

  it('formats a same-session edit as a duration', () => {
    expect(formatRecency({ state: 'current-session', agoMs: 120_000 })).toBe('2m ago');
  });

  it('singularizes one session', () => {
    expect(formatRecency({ state: 'earlier-session', sessionsAgo: 1 })).toBe('1 session ago');
  });

  it('pluralizes multiple sessions', () => {
    expect(formatRecency({ state: 'earlier-session', sessionsAgo: 3 })).toBe('3 sessions ago');
  });
});
