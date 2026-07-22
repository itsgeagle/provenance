import { describe, it, expect } from 'vitest';
import { PLATES, worldBounds, search, SEARCH_INDEX } from './layout.js';

describe('layout: PLATES', () => {
  it('has 13 plates', () => {
    expect(PLATES).toHaveLength(13);
  });

  it('every plate has numeric geometry, a two-digit no, and a non-empty svg', () => {
    for (const p of PLATES) {
      expect(typeof p.x).toBe('number');
      expect(typeof p.y).toBe('number');
      expect(typeof p.w).toBe('number');
      expect(typeof p.h).toBe('number');
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
      expect(Number.isFinite(p.w)).toBe(true);
      expect(Number.isFinite(p.h)).toBe(true);
      expect(p.no).toMatch(/^\d{2}$/);
      expect(typeof p.svg).toBe('string');
      expect(p.svg.length).toBeGreaterThan(0);
    }
  });
});

describe('layout: worldBounds', () => {
  it('returns positive dimensions covering every plate', () => {
    const bounds = worldBounds();
    expect(bounds.w).toBeGreaterThan(0);
    expect(bounds.h).toBeGreaterThan(0);
    for (const p of PLATES) {
      expect(p.x).toBeGreaterThanOrEqual(bounds.x);
      expect(p.y).toBeGreaterThanOrEqual(bounds.y);
      expect(p.x + p.w).toBeLessThanOrEqual(bounds.x + bounds.w);
      expect(p.y + p.h).toBeLessThanOrEqual(bounds.y + bounds.h);
    }
  });
});

describe('layout: search', () => {
  it('empty query returns only plate hits, one per plate, as a table of contents', () => {
    const hits = search('');
    expect(hits).toHaveLength(13);
    expect(hits.every((h) => h.kind === 'plate')).toBe(true);
  });

  it('returns hits for "paste" that all match in their haystack', () => {
    const hits = search('paste');
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      expect(h.haystack).toContain('paste');
    }
  });

  it('ranks a node hit for a known node title ("hash chain")', () => {
    const hits = search('hash chain');
    expect(hits.length).toBeGreaterThan(0);
    const nodeHit = hits.find((h) => h.kind === 'node');
    expect(nodeHit).toBeDefined();
    expect(nodeHit!.addr).toMatch(/^\w+:\w+$/);
  });

  it('sanity-checks the search index itself contains node entries', () => {
    expect(SEARCH_INDEX.some((h) => h.kind === 'node')).toBe(true);
  });

  it('returns no hits for a nonsense query', () => {
    expect(search('zzzznotfound')).toEqual([]);
  });
});
