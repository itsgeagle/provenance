import { describe, it, expect } from 'vitest';
import { SystemClock, FixedClock } from './clock.js';

const ISO_8601_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe('FixedClock', () => {
  it('starts at the given monotonic value', () => {
    const clock = new FixedClock(500, new Date('2026-01-01T00:00:00.000Z'));
    expect(clock.now()).toBe(500);
  });

  it('starts at the given wall time', () => {
    const clock = new FixedClock(0, new Date('2026-06-15T12:00:00.000Z'));
    expect(clock.wall()).toBe('2026-06-15T12:00:00.000Z');
  });

  it('advance() increments both now() and wall()', () => {
    const clock = new FixedClock(0, new Date('2026-01-01T00:00:00.000Z'));
    clock.advance(1000);
    expect(clock.now()).toBe(1000);
    expect(clock.wall()).toBe('2026-01-01T00:00:01.000Z');
  });

  it('advance() is cumulative across multiple calls', () => {
    const clock = new FixedClock(0, new Date('2026-01-01T00:00:00.000Z'));
    clock.advance(500);
    clock.advance(300);
    expect(clock.now()).toBe(800);
    expect(clock.wall()).toBe('2026-01-01T00:00:00.800Z');
  });

  it('setNow() overrides the monotonic value', () => {
    const clock = new FixedClock(0);
    clock.setNow(9999);
    expect(clock.now()).toBe(9999);
  });

  it('setWall() overrides the wall time', () => {
    const clock = new FixedClock(0, new Date('2026-01-01T00:00:00.000Z'));
    clock.setWall(new Date('2026-06-01T12:00:00.000Z'));
    expect(clock.wall()).toBe('2026-06-01T12:00:00.000Z');
  });

  it('is deterministic: two clocks initialized identically produce the same values', () => {
    const c1 = new FixedClock(100, new Date('2026-03-01T00:00:00.000Z'));
    const c2 = new FixedClock(100, new Date('2026-03-01T00:00:00.000Z'));
    c1.advance(250);
    c2.advance(250);
    expect(c1.now()).toBe(c2.now());
    expect(c1.wall()).toBe(c2.wall());
  });

  it('defaults to monotonic=0 and epoch wall when constructed with no args', () => {
    const clock = new FixedClock();
    expect(clock.now()).toBe(0);
    expect(clock.wall()).toBe(new Date(0).toISOString());
  });
});

describe('SystemClock', () => {
  it('wall() returns an ISO 8601 UTC string', () => {
    const clock = new SystemClock();
    expect(clock.wall()).toMatch(ISO_8601_REGEX);
  });

  it('now() is non-decreasing across two successive calls', () => {
    const clock = new SystemClock();
    const t1 = clock.now();
    const t2 = clock.now();
    expect(t2).toBeGreaterThanOrEqual(t1);
  });

  it('now() returns a number', () => {
    const clock = new SystemClock();
    expect(typeof clock.now()).toBe('number');
  });
});
