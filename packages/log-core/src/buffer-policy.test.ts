import { describe, it, expect } from 'vitest';
import { shouldFlush, DEFAULT_BUFFER_POLICY } from './buffer-policy.js';

describe('shouldFlush', () => {
  const defaults = DEFAULT_BUFFER_POLICY;

  it('returns false when bufferedBytes is 0, regardless of time elapsed', () => {
    expect(shouldFlush({ bufferedBytes: 0, lastFlushAtMs: 0, nowMs: 99999 })).toBe(false);
  });

  it('returns false when both thresholds are below limits', () => {
    expect(
      shouldFlush({
        bufferedBytes: 100,
        lastFlushAtMs: 0,
        nowMs: 500, // 500ms < 1000ms
      }),
    ).toBe(false);
  });

  it('returns true when bufferedBytes equals maxBytes (at threshold)', () => {
    expect(
      shouldFlush({
        bufferedBytes: defaults.maxBytes,
        lastFlushAtMs: 0,
        nowMs: 0, // time threshold not met
      }),
    ).toBe(true);
  });

  it('returns true when bufferedBytes exceeds maxBytes', () => {
    expect(
      shouldFlush({
        bufferedBytes: defaults.maxBytes + 1,
        lastFlushAtMs: 0,
        nowMs: 0,
      }),
    ).toBe(true);
  });

  it('returns true when time elapsed equals maxIntervalMs (at threshold)', () => {
    expect(
      shouldFlush({
        bufferedBytes: 1, // non-zero
        lastFlushAtMs: 1000,
        nowMs: 2000, // exactly 1000ms elapsed
      }),
    ).toBe(true);
  });

  it('returns true when time elapsed exceeds maxIntervalMs', () => {
    expect(
      shouldFlush({
        bufferedBytes: 1,
        lastFlushAtMs: 0,
        nowMs: 1500,
      }),
    ).toBe(true);
  });

  it('empty buffer does not trigger flush even if time threshold exceeded', () => {
    expect(
      shouldFlush({
        bufferedBytes: 0,
        lastFlushAtMs: 0,
        nowMs: defaults.maxIntervalMs * 10,
      }),
    ).toBe(false);
  });

  it('respects custom maxBytes config', () => {
    const config = { maxBytes: 512, maxIntervalMs: defaults.maxIntervalMs };
    // Below custom threshold
    expect(shouldFlush({ bufferedBytes: 511, lastFlushAtMs: 0, nowMs: 0 }, config)).toBe(false);
    // At custom threshold
    expect(shouldFlush({ bufferedBytes: 512, lastFlushAtMs: 0, nowMs: 0 }, config)).toBe(true);
  });

  it('respects custom maxIntervalMs config', () => {
    const config = { maxBytes: defaults.maxBytes, maxIntervalMs: 500 };
    // Below custom interval
    expect(shouldFlush({ bufferedBytes: 1, lastFlushAtMs: 0, nowMs: 499 }, config)).toBe(false);
    // At custom interval
    expect(shouldFlush({ bufferedBytes: 1, lastFlushAtMs: 0, nowMs: 500 }, config)).toBe(true);
  });

  it('DEFAULT_BUFFER_POLICY has maxBytes = 256 KiB and maxIntervalMs = 1000', () => {
    expect(defaults.maxBytes).toBe(256 * 1024);
    expect(defaults.maxIntervalMs).toBe(1000);
  });
});
