/**
 * engine-core.test.ts — pure engine state machine tests.
 *
 * Tests exercise advance-N-events-from-state-X → expected-state-Y pattern.
 * No React, no timers, no DOM.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createEngine } from './engine-core.js';
import type { EventIndex, IndexedEvent } from '../../index/event-index.js';
import type { EventKind } from '@provenance/log-core';

// ---------------------------------------------------------------------------
// Minimal EventIndex builder for tests
// ---------------------------------------------------------------------------

function makeEvent(
  overrides: Partial<IndexedEvent> & { kind: EventKind; globalIdx: number },
): IndexedEvent {
  const base: IndexedEvent = {
    sessionId: overrides.sessionId ?? 'sess1',
    seq: overrides.seq ?? overrides.globalIdx,
    globalIdx: overrides.globalIdx,
    wall: overrides.wall ?? '2026-01-01T00:00:00.000Z',
    t: overrides.t ?? overrides.globalIdx * 100,
    kind: overrides.kind,
    payload: overrides.payload ?? null,
  };
  if (overrides.file !== undefined) {
    base.file = overrides.file;
  }
  return base;
}

function makeDocChangeEvent(
  globalIdx: number,
  file: string,
  text: string,
  sessionId = 'sess1',
): IndexedEvent {
  return makeEvent({
    globalIdx,
    kind: 'doc.change' as const,
    file,
    sessionId,
    seq: globalIdx,
    payload: {
      deltas: [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          text,
        },
      ],
    },
  });
}

function buildIndex(events: IndexedEvent[]): EventIndex {
  const bySeq = new Map<string, IndexedEvent>();
  const byKind = new Map<EventKind, IndexedEvent[]>();
  const byFile = new Map<string, IndexedEvent[]>();
  const bySessionId = new Map<string, IndexedEvent[]>();
  const ordered = [...events].sort((a, b) => a.globalIdx - b.globalIdx);

  for (const e of ordered) {
    bySeq.set(`${e.sessionId}:${e.seq}`, e);

    const kindList = byKind.get(e.kind) ?? [];
    kindList.push(e);
    byKind.set(e.kind, kindList);

    if (e.file != null) {
      const fileList = byFile.get(e.file) ?? [];
      fileList.push(e);
      byFile.set(e.file, fileList);
    }

    const sessionList = bySessionId.get(e.sessionId) ?? [];
    sessionList.push(e);
    bySessionId.set(e.sessionId, sessionList);
  }

  return { bySeq, byKind, byFile, bySessionId, ordered };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createEngine', () => {
  describe('initial state', () => {
    it('starts paused at -1 with empty file states', () => {
      const events = [makeDocChangeEvent(0, 'hw.py', 'x')];
      const index = buildIndex(events);
      const engine = createEngine(index, 'sess1');
      const state = engine.getState();

      expect(state.status).toBe('paused');
      expect(state.currentGlobalIdx).toBe(-1);
      expect(state.speed).toBe(1);
      expect(state.sessionId).toBe('sess1');
    });

    it('returns empty content for all files at -1', () => {
      const events = [makeDocChangeEvent(0, 'hw.py', 'hello')];
      const index = buildIndex(events);
      const engine = createEngine(index, 'sess1');

      const fileStates = engine.getFileStates();
      expect(fileStates.get('hw.py')?.content).toBe('');
    });

    it('lists files under review', () => {
      const events = [
        makeDocChangeEvent(0, 'hw.py', 'a'),
        makeDocChangeEvent(1, 'utils.py', 'b'),
        makeDocChangeEvent(2, 'hw.py', 'c'),
      ];
      const index = buildIndex(events);
      const engine = createEngine(index, 'sess1');
      // files appear in order of first appearance
      expect(engine.getFiles()).toEqual(['hw.py', 'utils.py']);
    });

    it('returns 0 event count for unknown session', () => {
      const index = buildIndex([]);
      const engine = createEngine(index, 'no-such-session');
      expect(engine.eventCount()).toBe(0);
    });
  });

  describe('seek', () => {
    let engine: ReturnType<typeof createEngine>;

    beforeEach(() => {
      // 3 doc.change events inserting chars at position 0 in hw.py
      const events = [
        makeDocChangeEvent(0, 'hw.py', 'a'),
        makeDocChangeEvent(1, 'hw.py', 'b'),
        makeDocChangeEvent(2, 'hw.py', 'c'),
      ];
      const index = buildIndex(events);
      engine = createEngine(index, 'sess1');
    });

    it('seek(0) applies the first event (inclusive)', () => {
      const state = engine.seek(0);
      expect(state.currentGlobalIdx).toBe(0);
      const content = engine.getFileStates().get('hw.py')?.content;
      // event 0 inserts 'a' at pos 0 of empty string
      expect(content).toBe('a');
    });

    it('seek(1) applies events 0 and 1', () => {
      engine.seek(1);
      const content = engine.getFileStates().get('hw.py')?.content;
      // event 0 inserts 'a' at pos 0 → 'a'
      // event 1 inserts 'b' at pos 0 → 'ba'
      expect(content).toBe('ba');
    });

    it('seek(-1) resets to empty state', () => {
      engine.seek(2);
      engine.seek(-1);
      const state = engine.getState();
      expect(state.currentGlobalIdx).toBe(-1);
      expect(engine.getFileStates().get('hw.py')?.content).toBe('');
    });

    it('seek past end clamps to last event', () => {
      const state = engine.seek(999);
      expect(state.currentGlobalIdx).toBe(2); // events.length - 1
    });

    it('seek before -1 clamps to -1', () => {
      const state = engine.seek(-100);
      expect(state.currentGlobalIdx).toBe(-1);
    });

    it('status remains paused after seek', () => {
      const state = engine.seek(1);
      expect(state.status).toBe('paused');
    });
  });

  describe('step', () => {
    let engine: ReturnType<typeof createEngine>;

    beforeEach(() => {
      const events = [
        makeDocChangeEvent(0, 'hw.py', 'a'),
        makeDocChangeEvent(1, 'hw.py', 'b'),
        makeDocChangeEvent(2, 'hw.py', 'c'),
      ];
      const index = buildIndex(events);
      engine = createEngine(index, 'sess1');
    });

    it('step() with no arg advances by 1', () => {
      engine.step();
      expect(engine.getState().currentGlobalIdx).toBe(0);
    });

    it('step(2) advances by 2', () => {
      engine.step(2);
      expect(engine.getState().currentGlobalIdx).toBe(1);
    });

    it('step(-1) retreats by 1', () => {
      engine.seek(2);
      engine.step(-1);
      expect(engine.getState().currentGlobalIdx).toBe(1);
    });

    it('step clamped at end', () => {
      engine.seek(2);
      const state = engine.step(1);
      expect(state.currentGlobalIdx).toBe(2);
    });

    it('step clamped at start', () => {
      engine.seek(0);
      const state = engine.step(-1);
      expect(state.currentGlobalIdx).toBe(-1);
    });
  });

  describe('setPlaying / setPaused', () => {
    it('setPlaying sets status to playing', () => {
      const events = [makeDocChangeEvent(0, 'hw.py', 'x')];
      const index = buildIndex(events);
      const engine = createEngine(index, 'sess1');
      const state = engine.setPlaying();
      expect(state.status).toBe('playing');
    });

    it('setPaused sets status to paused', () => {
      const events = [makeDocChangeEvent(0, 'hw.py', 'x')];
      const index = buildIndex(events);
      const engine = createEngine(index, 'sess1');
      engine.setPlaying();
      const state = engine.setPaused();
      expect(state.status).toBe('paused');
    });

    it('seek does not change playing status', () => {
      const events = [makeDocChangeEvent(0, 'hw.py', 'x'), makeDocChangeEvent(1, 'hw.py', 'y')];
      const index = buildIndex(events);
      const engine = createEngine(index, 'sess1');
      engine.setPlaying();
      const state = engine.seek(1);
      expect(state.status).toBe('playing');
    });
  });

  describe('setSpeed', () => {
    it('updates speed', () => {
      const index = buildIndex([makeDocChangeEvent(0, 'hw.py', 'x')]);
      const engine = createEngine(index, 'sess1');
      const state = engine.setSpeed(4);
      expect(state.speed).toBe(4);
    });
  });

  describe('eventCount', () => {
    it('returns total number of session events', () => {
      const events = [makeDocChangeEvent(0, 'hw.py', 'a'), makeDocChangeEvent(1, 'hw.py', 'b')];
      const index = buildIndex(events);
      const engine = createEngine(index, 'sess1');
      expect(engine.eventCount()).toBe(2);
    });
  });

  describe('multi-file', () => {
    it('tracks file states independently', () => {
      const events = [
        makeDocChangeEvent(0, 'hw.py', 'hello'),
        makeDocChangeEvent(1, 'utils.py', 'world'),
        makeDocChangeEvent(2, 'hw.py', ' '),
      ];
      const index = buildIndex(events);
      const engine = createEngine(index, 'sess1');
      engine.seek(2);
      const fileStates = engine.getFileStates();
      // hw.py: event 0 inserts 'hello' then event 2 inserts ' ' at pos 0 → ' hello'
      expect(fileStates.get('hw.py')?.content).toBe(' hello');
      // utils.py: only event 1 → 'world'
      expect(fileStates.get('utils.py')?.content).toBe('world');
    });
  });

  describe('empty session', () => {
    it('handles session with no events gracefully', () => {
      const index = buildIndex([]);
      const engine = createEngine(index, 'sess1');
      expect(engine.eventCount()).toBe(0);
      expect(engine.getFiles()).toEqual([]);
      const state = engine.step(1);
      expect(state.currentGlobalIdx).toBe(-1);
    });
  });

  describe('getFileStates returns a copy', () => {
    it('mutating returned map does not affect engine', () => {
      const events = [makeDocChangeEvent(0, 'hw.py', 'x')];
      const index = buildIndex(events);
      const engine = createEngine(index, 'sess1');
      engine.seek(0);
      const fileStates = engine.getFileStates();
      fileStates.delete('hw.py');
      // Engine's internal map still has hw.py
      expect(engine.getFileStates().has('hw.py')).toBe(true);
    });
  });
});
