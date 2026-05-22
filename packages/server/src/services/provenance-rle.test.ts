/**
 * Unit tests for provenance-rle.ts — Phase 18.
 */

import { describe, it, expect } from 'vitest';
import { encodeRle } from './provenance-rle.js';
import type { ProvenanceKind } from '@provenance/analyzer/src/index/reconstruct-file-provenance.js';

// Helper to build a kindByGlobalIdx map from an object literal.
function kinds(entries: Record<number, ProvenanceKind>): Map<number, ProvenanceKind> {
  return new Map(Object.entries(entries).map(([k, v]) => [Number(k), v]));
}

describe('encodeRle', () => {
  it('empty provenance → []', () => {
    expect(encodeRle([], new Map())).toEqual([]);
  });

  it('single character → single run', () => {
    const result = encodeRle([5], kinds({ 5: 'typed' }));
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ offset: 0, length: 1, kind: 'typed', event_seq: 5 });
  });

  it('all same globalIdx + kind → single run', () => {
    const result = encodeRle([3, 3, 3, 3], kinds({ 3: 'paste' }));
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ offset: 0, length: 4, kind: 'paste', event_seq: 3 });
  });

  it('alternating globalIdx → one run per character', () => {
    const result = encodeRle([1, 2, 1, 2], kinds({ 1: 'typed', 2: 'typed' }));
    expect(result).toHaveLength(4);
    expect(result.map((r) => r.event_seq)).toEqual([1, 2, 1, 2]);
    expect(result.map((r) => r.offset)).toEqual([0, 1, 2, 3]);
    expect(result.every((r) => r.length === 1)).toBe(true);
  });

  it('alternating kind with same globalIdx → new run per kind change', () => {
    // Suppose globalIdx 10 is sometimes 'paste', sometimes 'typed'
    // (unusual but kindByGlobalIdx has one entry; run changes happen only on idx change here)
    // For this test, two different idx each with different kinds.
    const result = encodeRle([10, 10, 20, 20], kinds({ 10: 'preexisting', 20: 'external_change' }));
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ offset: 0, length: 2, kind: 'preexisting', event_seq: 10 });
    expect(result[1]).toEqual({ offset: 2, length: 2, kind: 'external_change', event_seq: 20 });
  });

  it('runs cover the full content length', () => {
    const provenance = [1, 1, 1, 2, 2, 3];
    const k = kinds({ 1: 'typed', 2: 'paste', 3: 'typed' });
    const result = encodeRle(provenance, k);
    const totalLength = result.reduce((sum, r) => sum + r.length, 0);
    expect(totalLength).toBe(provenance.length);
  });

  it('unknown globalIdx falls back to typed', () => {
    // globalIdx 999 not in map → 'typed' fallback
    const result = encodeRle([999], new Map());
    expect(result).toHaveLength(1);
    expect(result[0]!.kind).toBe('typed');
  });

  it('three-segment run with correct offsets', () => {
    const provenance = [0, 0, 1, 1, 1, 2];
    const k = kinds({ 0: 'preexisting', 1: 'typed', 2: 'paste' });
    const result = encodeRle(provenance, k);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ offset: 0, length: 2, kind: 'preexisting', event_seq: 0 });
    expect(result[1]).toEqual({ offset: 2, length: 3, kind: 'typed', event_seq: 1 });
    expect(result[2]).toEqual({ offset: 5, length: 1, kind: 'paste', event_seq: 2 });
  });
});
