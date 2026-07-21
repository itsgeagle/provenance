/**
 * Tests for the heuristics config defaults and merge semantics.
 */

import { describe, it, expect } from 'vitest';
import { DEFAULT_HEURISTIC_CONFIG, mergeConfig } from './config.js';

describe('internalMove config', () => {
  it('has the documented defaults', () => {
    expect(DEFAULT_HEURISTIC_CONFIG.internalMove).toEqual({
      enabled: true,
      minMatchRatio: 0.95,
      typedRatio: 0.9,
      ledgerMaxBytes: 1_000_000,
      minBlobChars: 40,
    });
  });

  it('merges a partial override without dropping sibling fields', () => {
    const merged = mergeConfig({ internalMove: { enabled: false } as never });
    expect(merged.internalMove.enabled).toBe(false);
    expect(merged.internalMove.minMatchRatio).toBe(0.95);
    expect(merged.internalMove.typedRatio).toBe(0.9);
    expect(merged.internalMove.minBlobChars).toBe(40);
  });

  it('leaves unrelated sections untouched when overriding internalMove', () => {
    const merged = mergeConfig({ internalMove: { enabled: false } as never });
    expect(merged.largePaste).toEqual(DEFAULT_HEURISTIC_CONFIG.largePaste);
    expect(merged.pasteIsSolution).toEqual(DEFAULT_HEURISTIC_CONFIG.pasteIsSolution);
  });
});
