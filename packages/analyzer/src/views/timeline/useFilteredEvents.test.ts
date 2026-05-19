/**
 * Tests for useFilteredEvents — pure filter logic.
 *
 * Tests eventPassesFilters directly (pure function) plus the hook behavior.
 */

import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { IndexedEvent } from '../../index/event-index.js';
import {
  eventPassesFilters,
  useFilteredEvents,
  DEFAULT_FILTERS,
  type TimelineFilters,
} from './useFilteredEvents.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<IndexedEvent>): IndexedEvent {
  return {
    sessionId: 'session-abc',
    seq: 0,
    globalIdx: 0,
    wall: '2026-01-01T00:00:00.000Z',
    t: 0,
    kind: 'doc.change',
    payload: {},
    ...overrides,
  };
}

function makeFilters(overrides: Partial<TimelineFilters>): TimelineFilters {
  return { ...DEFAULT_FILTERS, ...overrides };
}

// ---------------------------------------------------------------------------
// eventPassesFilters — pure function tests
// ---------------------------------------------------------------------------

describe('eventPassesFilters', () => {
  describe('empty filters (default)', () => {
    it('passes all events when no filters active', () => {
      const event = makeEvent({ kind: 'paste', t: 5000 });
      expect(eventPassesFilters(event, DEFAULT_FILTERS)).toBe(true);
    });

    it('passes session.start event with empty filters', () => {
      const event = makeEvent({ kind: 'session.start', sessionId: 'xyz' });
      expect(eventPassesFilters(event, DEFAULT_FILTERS)).toBe(true);
    });
  });

  describe('kind filter', () => {
    it('passes event with matching kind', () => {
      const event = makeEvent({ kind: 'paste' });
      const filters = makeFilters({ kinds: new Set(['paste']) });
      expect(eventPassesFilters(event, filters)).toBe(true);
    });

    it('rejects event with non-matching kind', () => {
      const event = makeEvent({ kind: 'doc.change' });
      const filters = makeFilters({ kinds: new Set(['paste']) });
      expect(eventPassesFilters(event, filters)).toBe(false);
    });

    it('passes event when multiple kinds selected and event matches one', () => {
      const event = makeEvent({ kind: 'doc.save' });
      const filters = makeFilters({ kinds: new Set(['paste', 'doc.save', 'doc.change']) });
      expect(eventPassesFilters(event, filters)).toBe(true);
    });

    it('rejects event when multiple kinds selected and event matches none', () => {
      const event = makeEvent({ kind: 'session.start' });
      const filters = makeFilters({ kinds: new Set(['paste', 'doc.save']) });
      expect(eventPassesFilters(event, filters)).toBe(false);
    });

    it('empty kinds set = no kind filter (passes all)', () => {
      const event = makeEvent({ kind: 'terminal.command' });
      const filters = makeFilters({ kinds: new Set() });
      expect(eventPassesFilters(event, filters)).toBe(true);
    });
  });

  describe('file filter', () => {
    it('passes event with matching file', () => {
      const event = makeEvent({ file: 'hw1.py' });
      const filters = makeFilters({ files: new Set(['hw1.py']) });
      expect(eventPassesFilters(event, filters)).toBe(true);
    });

    it('rejects event with non-matching file', () => {
      const event = makeEvent({ file: 'hw2.py' });
      const filters = makeFilters({ files: new Set(['hw1.py']) });
      expect(eventPassesFilters(event, filters)).toBe(false);
    });

    it('rejects event with undefined file when file filter active', () => {
      // makeEvent default has no file
      const event = makeEvent({});
      const filters = makeFilters({ files: new Set(['hw1.py']) });
      expect(eventPassesFilters(event, filters)).toBe(false);
    });

    it('empty files set = no file filter (passes all)', () => {
      const event = makeEvent({ file: 'anything.py' });
      const filters = makeFilters({ files: new Set() });
      expect(eventPassesFilters(event, filters)).toBe(true);
    });
  });

  describe('time range filter', () => {
    it('passes event within range [start, end]', () => {
      const event = makeEvent({ t: 5000 });
      const filters = makeFilters({ timeRangeMs: { start: 1000, end: 10000 } });
      expect(eventPassesFilters(event, filters)).toBe(true);
    });

    it('rejects event before start', () => {
      const event = makeEvent({ t: 500 });
      const filters = makeFilters({ timeRangeMs: { start: 1000, end: 10000 } });
      expect(eventPassesFilters(event, filters)).toBe(false);
    });

    it('rejects event after end', () => {
      const event = makeEvent({ t: 15000 });
      const filters = makeFilters({ timeRangeMs: { start: 1000, end: 10000 } });
      expect(eventPassesFilters(event, filters)).toBe(false);
    });

    it('passes at exact start boundary', () => {
      const event = makeEvent({ t: 1000 });
      const filters = makeFilters({ timeRangeMs: { start: 1000, end: 10000 } });
      expect(eventPassesFilters(event, filters)).toBe(true);
    });

    it('passes at exact end boundary', () => {
      const event = makeEvent({ t: 10000 });
      const filters = makeFilters({ timeRangeMs: { start: 1000, end: 10000 } });
      expect(eventPassesFilters(event, filters)).toBe(true);
    });

    it('null start = unbounded below', () => {
      const event = makeEvent({ t: 0 });
      const filters = makeFilters({ timeRangeMs: { start: null, end: 5000 } });
      expect(eventPassesFilters(event, filters)).toBe(true);
    });

    it('null end = unbounded above', () => {
      const event = makeEvent({ t: 999999 });
      const filters = makeFilters({ timeRangeMs: { start: 1000, end: null } });
      expect(eventPassesFilters(event, filters)).toBe(true);
    });

    it('both null = no time filter', () => {
      const event = makeEvent({ t: 42 });
      const filters = makeFilters({ timeRangeMs: { start: null, end: null } });
      expect(eventPassesFilters(event, filters)).toBe(true);
    });
  });

  describe('session filter', () => {
    it('passes event with matching sessionId', () => {
      const event = makeEvent({ sessionId: 'abc-123' });
      const filters = makeFilters({ sessionIds: new Set(['abc-123']) });
      expect(eventPassesFilters(event, filters)).toBe(true);
    });

    it('rejects event with non-matching sessionId', () => {
      const event = makeEvent({ sessionId: 'abc-123' });
      const filters = makeFilters({ sessionIds: new Set(['def-456']) });
      expect(eventPassesFilters(event, filters)).toBe(false);
    });

    it('empty sessionIds set = no session filter', () => {
      const event = makeEvent({ sessionId: 'any-session' });
      const filters = makeFilters({ sessionIds: new Set() });
      expect(eventPassesFilters(event, filters)).toBe(true);
    });
  });

  describe('combined filters (AND logic)', () => {
    it('passes event meeting all filter conditions', () => {
      const event = makeEvent({
        kind: 'paste',
        file: 'hw1.py',
        t: 5000,
        sessionId: 'session-abc',
      });
      const filters = makeFilters({
        kinds: new Set(['paste']),
        files: new Set(['hw1.py']),
        timeRangeMs: { start: 1000, end: 10000 },
        sessionIds: new Set(['session-abc']),
      });
      expect(eventPassesFilters(event, filters)).toBe(true);
    });

    it('rejects event failing any one condition (kind wrong)', () => {
      const event = makeEvent({
        kind: 'doc.change',
        file: 'hw1.py',
        t: 5000,
        sessionId: 'session-abc',
      });
      const filters = makeFilters({
        kinds: new Set(['paste']),
        files: new Set(['hw1.py']),
        timeRangeMs: { start: 1000, end: 10000 },
        sessionIds: new Set(['session-abc']),
      });
      expect(eventPassesFilters(event, filters)).toBe(false);
    });

    it('rejects event failing any one condition (file wrong)', () => {
      const event = makeEvent({
        kind: 'paste',
        file: 'hw2.py',
        t: 5000,
        sessionId: 'session-abc',
      });
      const filters = makeFilters({
        kinds: new Set(['paste']),
        files: new Set(['hw1.py']),
      });
      expect(eventPassesFilters(event, filters)).toBe(false);
    });

    it('rejects event failing any one condition (time out of range)', () => {
      const event = makeEvent({
        kind: 'paste',
        file: 'hw1.py',
        t: 50000,
        sessionId: 'session-abc',
      });
      const filters = makeFilters({
        kinds: new Set(['paste']),
        timeRangeMs: { start: 0, end: 10000 },
      });
      expect(eventPassesFilters(event, filters)).toBe(false);
    });

    it('rejects event failing any one condition (session wrong)', () => {
      const event = makeEvent({
        kind: 'paste',
        sessionId: 'other-session',
      });
      const filters = makeFilters({
        kinds: new Set(['paste']),
        sessionIds: new Set(['session-abc']),
      });
      expect(eventPassesFilters(event, filters)).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// useFilteredEvents hook tests
// ---------------------------------------------------------------------------

describe('useFilteredEvents', () => {
  const events: IndexedEvent[] = [
    makeEvent({ globalIdx: 0, kind: 'session.start', t: 0, sessionId: 'sess-1' }),
    makeEvent({ globalIdx: 1, kind: 'doc.change', t: 1000, file: 'hw1.py', sessionId: 'sess-1' }),
    makeEvent({ globalIdx: 2, kind: 'paste', t: 2000, file: 'hw1.py', sessionId: 'sess-1' }),
    makeEvent({ globalIdx: 3, kind: 'doc.save', t: 3000, file: 'hw2.py', sessionId: 'sess-2' }),
    makeEvent({
      globalIdx: 4,
      kind: 'terminal.command',
      t: 4000,
      sessionId: 'sess-2',
    }),
  ];

  it('returns all events with default (empty) filters', () => {
    const { result } = renderHook(() => useFilteredEvents(events, DEFAULT_FILTERS));
    expect(result.current).toHaveLength(5);
  });

  it('filters by kind', () => {
    const filters = makeFilters({ kinds: new Set(['paste']) });
    const { result } = renderHook(() => useFilteredEvents(events, filters));
    expect(result.current).toHaveLength(1);
    expect(result.current[0]!.kind).toBe('paste');
  });

  it('filters by file', () => {
    const filters = makeFilters({ files: new Set(['hw1.py']) });
    const { result } = renderHook(() => useFilteredEvents(events, filters));
    expect(result.current).toHaveLength(2);
    expect(result.current.every((e) => e.file === 'hw1.py')).toBe(true);
  });

  it('filters by time range', () => {
    const filters = makeFilters({ timeRangeMs: { start: 1500, end: 3500 } });
    const { result } = renderHook(() => useFilteredEvents(events, filters));
    // Should include t=2000 and t=3000
    expect(result.current).toHaveLength(2);
    expect(result.current[0]!.kind).toBe('paste');
    expect(result.current[1]!.kind).toBe('doc.save');
  });

  it('filters by sessionId', () => {
    const filters = makeFilters({ sessionIds: new Set(['sess-2']) });
    const { result } = renderHook(() => useFilteredEvents(events, filters));
    expect(result.current).toHaveLength(2);
    expect(result.current.every((e) => e.sessionId === 'sess-2')).toBe(true);
  });

  it('combined filters reduce result set', () => {
    const filters = makeFilters({
      kinds: new Set(['doc.change', 'paste']),
      files: new Set(['hw1.py']),
    });
    const { result } = renderHook(() => useFilteredEvents(events, filters));
    expect(result.current).toHaveLength(2);
  });

  it('returns empty array when no events match', () => {
    const filters = makeFilters({ kinds: new Set(['fs.external_change']) });
    const { result } = renderHook(() => useFilteredEvents(events, filters));
    expect(result.current).toHaveLength(0);
  });

  it('handles empty events list', () => {
    const { result } = renderHook(() => useFilteredEvents([], DEFAULT_FILTERS));
    expect(result.current).toHaveLength(0);
  });
});
