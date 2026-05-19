import { describe, it, expect } from 'vitest';
import { formatDuration } from './format.js';

describe('formatDuration', () => {
  it('returns 0s for zero', () => {
    expect(formatDuration(0)).toBe('0s');
  });

  it('returns 0s for negative', () => {
    expect(formatDuration(-100)).toBe('0s');
  });

  it('renders seconds only for < 1 minute', () => {
    expect(formatDuration(12_000)).toBe('12s');
    expect(formatDuration(59_999)).toBe('59s');
    expect(formatDuration(1_000)).toBe('1s');
  });

  it('renders minutes and seconds for 1–59 minutes', () => {
    expect(formatDuration(60_000)).toBe('1m 0s');
    expect(formatDuration(75_000)).toBe('1m 15s');
    expect(formatDuration(2_732_000)).toBe('45m 32s');
  });

  it('renders hours and minutes for >= 1 hour', () => {
    expect(formatDuration(3_600_000)).toBe('1h 0m');
    expect(formatDuration(5_580_000)).toBe('1h 33m');
    expect(formatDuration(90_061_000)).toBe('25h 1m');
  });
});
