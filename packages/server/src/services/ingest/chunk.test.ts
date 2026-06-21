import { describe, it, expect } from 'vitest';
import { chunk } from './chunk.js';

describe('chunk', () => {
  it('splits into ceil(n/size) groups with the remainder last', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('returns a single chunk when size >= length', () => {
    expect(chunk([1, 2, 3], 10)).toEqual([[1, 2, 3]]);
  });

  it('returns [] for an empty input', () => {
    expect(chunk([], 5)).toEqual([]);
  });

  it('handles an exact multiple with no trailing empty chunk', () => {
    expect(chunk([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]]);
  });

  it('preserves order across chunk boundaries', () => {
    const flat = chunk([0, 1, 2, 3, 4, 5, 6], 3).flat();
    expect(flat).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('rejects a non-positive or non-integer size', () => {
    expect(() => chunk([1], 0)).toThrow(/positive integer/);
    expect(() => chunk([1], -2)).toThrow(/positive integer/);
    expect(() => chunk([1], 1.5)).toThrow(/positive integer/);
  });
});
