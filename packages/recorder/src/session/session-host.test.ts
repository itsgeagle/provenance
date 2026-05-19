/**
 * Unit tests for createSessionHost.
 * Uses FixedClock for deterministic time. CLAUDE.md: "Tests must be deterministic."
 */

import { describe, it, expect } from 'vitest';
import { FixedClock, validateChain, GENESIS_PREV_HASH } from '@provenance/log-core';
import type { HashedEnvelope } from '@provenance/log-core';
import { createSessionHost } from './session-host.js';

describe('createSessionHost', () => {
  function makeHost(clockStart: number = 0) {
    const clock = new FixedClock(clockStart, new Date('2026-01-01T00:00:00.000Z'));
    const entries: HashedEnvelope[] = [];
    const host = createSessionHost({
      sessionId: 'test-session-id',
      clock,
      onEntry: (entry) => entries.push(entry),
    });
    return { host, clock, entries };
  }

  it('starts with seq === 0', () => {
    const { host } = makeHost();
    expect(host.seq).toBe(0);
  });

  it('seq increments after each emit', () => {
    const { host } = makeHost();
    host.emit('session.end', { reason: 'test' });
    expect(host.seq).toBe(1);
    host.emit('session.end', { reason: 'test2' });
    expect(host.seq).toBe(2);
    host.emit('session.end', { reason: 'test3' });
    expect(host.seq).toBe(3);
  });

  it('emits entries with correct seq values (0, 1, 2)', () => {
    const { host, entries } = makeHost();
    host.emit('session.end', { reason: 'a' });
    host.emit('session.end', { reason: 'b' });
    host.emit('session.end', { reason: 'c' });
    expect(entries).toHaveLength(3);
    expect(entries[0]?.seq).toBe(0);
    expect(entries[1]?.seq).toBe(1);
    expect(entries[2]?.seq).toBe(2);
  });

  it('first entry has prev_hash === GENESIS_PREV_HASH', () => {
    const { host, entries } = makeHost();
    host.emit('session.end', { reason: 'first' });
    expect(entries[0]?.prev_hash).toBe(GENESIS_PREV_HASH);
  });

  it('each prev_hash matches the previous entry hash', () => {
    const { host, entries } = makeHost();
    host.emit('session.end', { reason: 'a' });
    host.emit('session.end', { reason: 'b' });
    host.emit('session.end', { reason: 'c' });
    expect(entries[1]?.prev_hash).toBe(entries[0]?.hash);
    expect(entries[2]?.prev_hash).toBe(entries[1]?.hash);
  });

  it('t increases as clock advances', () => {
    const { host, clock, entries } = makeHost(0);
    host.emit('session.end', { reason: 'first' }); // t=0
    clock.advance(500);
    host.emit('session.end', { reason: 'second' }); // t=500
    clock.advance(250);
    host.emit('session.end', { reason: 'third' }); // t=750
    expect(entries[0]?.t).toBe(0);
    expect(entries[1]?.t).toBe(500);
    expect(entries[2]?.t).toBe(750);
  });

  it('t is always >= 0 even if clock goes backward (floor at 0)', () => {
    const { host, clock, entries } = makeHost(1000);
    // tStart = 1000; clock.now() starts at 1000, so first t = max(0, 1000-1000) = 0
    host.emit('session.end', { reason: 'zero' });
    // Simulate clock going below tStart (shouldn't happen with a real monotonic clock
    // but defensive coding is required here).
    clock.setNow(500);
    host.emit('session.end', { reason: 'negative' });
    expect(entries[0]?.t).toBe(0);
    expect(entries[1]?.t).toBe(0);
  });

  it('wall clock value is present and non-empty', () => {
    const { host, entries } = makeHost();
    host.emit('session.end', { reason: 'test' });
    expect(typeof entries[0]?.wall).toBe('string');
    expect(entries[0]?.wall.length).toBeGreaterThan(0);
  });

  it('chain validates via validateChain from log-core', () => {
    const { host, entries } = makeHost();
    host.emit('session.end', { reason: 'a' });
    host.emit('session.end', { reason: 'b' });
    host.emit('session.end', { reason: 'c' });
    const result = validateChain(entries);
    expect(result.ok).toBe(true);
  });

  it('exposes the correct sessionId', () => {
    const clock = new FixedClock(0);
    const host = createSessionHost({
      sessionId: 'my-unique-id',
      clock,
      onEntry: () => undefined,
    });
    expect(host.sessionId).toBe('my-unique-id');
  });

  it('tStartMs reflects the clock value at construction', () => {
    const { host } = makeHost(9999);
    expect(host.tStartMs).toBe(9999);
  });

  it('returns the emitted HashedEnvelope from emit()', () => {
    const { host, entries } = makeHost();
    const entry = host.emit('session.end', { reason: 'returned' });
    expect(entry).toBe(entries[0]);
    expect(entry.seq).toBe(0);
    expect(entry.kind).toBe('session.end');
  });

  it('emits correct kind and data payload', () => {
    const { host, entries } = makeHost();
    host.emit('session.heartbeat', { focused: true, active_file: 'hw.py', idle_since_ms: 0 });
    expect(entries[0]?.kind).toBe('session.heartbeat');
    const data = entries[0]?.data as {
      focused: boolean;
      active_file: string;
      idle_since_ms: number;
    };
    expect(data.focused).toBe(true);
    expect(data.active_file).toBe('hw.py');
  });
});
