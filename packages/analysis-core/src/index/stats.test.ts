/**
 * Tests for stats.ts (Phase 3).
 */

import { describe, it, expect } from 'vitest';
import { computeStats } from './stats.js';
import { buildIndex } from './build-index.js';
import { loadBundle } from '../loader/parse-bundle.js';
import { buildTestBundle } from '../test-support/build-test-bundle.js';
import { sha256Hex } from '@provenance/log-core';

// ---------------------------------------------------------------------------
// Helper: build bundle, load, and index
// ---------------------------------------------------------------------------

async function buildAndIndex(opts: Parameters<typeof buildTestBundle>[0]) {
  const { zipBuffer } = await buildTestBundle(opts);
  const result = await loadBundle(new Blob([zipBuffer]), 'test.zip');
  if (!result.ok) throw new Error('Expected successful bundle load');
  return buildIndex(result.value);
}

// ---------------------------------------------------------------------------
// sessionCount
// ---------------------------------------------------------------------------

describe('computeStats — sessionCount', () => {
  it('counts sessions correctly for a single-session bundle', async () => {
    const index = await buildAndIndex({ sessions: [{ eventCount: 3 }] });
    const stats = computeStats(index);
    expect(stats.sessionCount).toBe(1);
  });

  it('counts sessions correctly for a multi-session bundle', async () => {
    const index = await buildAndIndex({ sessions: [{ eventCount: 2 }, { eventCount: 2 }] });
    const stats = computeStats(index);
    expect(stats.sessionCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// charsTyped
// ---------------------------------------------------------------------------

describe('computeStats — charsTyped', () => {
  it('sums inserted character lengths from doc.change events', async () => {
    // Default bundle: inserts 'x1' (2 chars), 'x2' (2 chars), 'x3' (2 chars) = 6 total.
    const index = await buildAndIndex({ sessions: [{ eventCount: 3 }] });
    const stats = computeStats(index);

    const fileStats = stats.perFile.get('/test/file.py');
    expect(fileStats).toBeDefined();
    expect(fileStats?.charsTyped).toBe(6); // 'x1' + 'x2' + 'x3'
  });

  it('sums across multiple sessions for the same file', async () => {
    // Session 0: 2 events (2+2=4 chars), Session 1: 3 events (2+2+2=6 chars).
    const index = await buildAndIndex({
      sessions: [{ eventCount: 2 }, { eventCount: 3 }],
    });
    const stats = computeStats(index);

    // Both sessions write to /test/file.py.
    const fileStats = stats.perFile.get('/test/file.py');
    expect(fileStats).toBeDefined();
    expect(fileStats?.charsTyped).toBe(10); // 4 + 6
  });
});

// ---------------------------------------------------------------------------
// charsPasted
// ---------------------------------------------------------------------------

describe('computeStats — charsPasted', () => {
  it('sums paste lengths from paste events (uses length field)', async () => {
    const index = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'paste',
              data: {
                path: '/src/main.py',
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                length: 42,
                sha256: 'abc',
                content: 'x'.repeat(42),
              },
            },
            {
              kind: 'paste',
              data: {
                path: '/src/main.py',
                range: { start: { line: 0, character: 42 }, end: { line: 0, character: 42 } },
                length: 100,
                sha256: 'def',
                // No content field = large paste, but length is always counted.
              },
            },
          ],
        },
      ],
    });
    const stats = computeStats(index);

    const fileStats = stats.perFile.get('/src/main.py');
    expect(fileStats).toBeDefined();
    expect(fileStats?.charsPasted).toBe(142); // 42 + 100
  });
});

// ---------------------------------------------------------------------------
// charsExternalChangeDelta
// ---------------------------------------------------------------------------

describe('computeStats — charsExternalChangeDelta', () => {
  it('sums diff_size from fs.external_change events', async () => {
    const index = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'fs.external_change',
              data: {
                path: '/src/app.py',
                old_hash: 'aaa',
                new_hash: 'bbb',
                diff_size: 25,
              },
            },
            {
              kind: 'fs.external_change',
              data: {
                path: '/src/app.py',
                old_hash: 'bbb',
                new_hash: 'ccc',
                diff_size: 10,
              },
            },
          ],
        },
      ],
    });
    const stats = computeStats(index);

    const fileStats = stats.perFile.get('/src/app.py');
    expect(fileStats).toBeDefined();
    expect(fileStats?.charsExternalChangeDelta).toBe(35);
  });
});

// ---------------------------------------------------------------------------
// saves
// ---------------------------------------------------------------------------

describe('computeStats — saves', () => {
  it('counts doc.save events per file', async () => {
    const finalContent = 'x1'; // eventCount=1 → 'x1'
    const saveHash = sha256Hex(finalContent);

    const index = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'doc.change',
              data: {
                path: '/src/main.py',
                deltas: [
                  {
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                    text: finalContent,
                  },
                ],
                source: 'typed',
              },
            },
            {
              kind: 'doc.save',
              data: { path: '/src/main.py', sha256: saveHash },
            },
            {
              kind: 'doc.save',
              data: { path: '/src/main.py', sha256: saveHash },
            },
          ],
        },
      ],
    });
    const stats = computeStats(index);

    const fileStats = stats.perFile.get('/src/main.py');
    expect(fileStats?.saves).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// reconstructionTainted
// ---------------------------------------------------------------------------

describe('computeStats — reconstructionTainted', () => {
  it('is false for a clean file', async () => {
    const index = await buildAndIndex({ sessions: [{ eventCount: 3 }] });
    const stats = computeStats(index);

    const fileStats = stats.perFile.get('/test/file.py');
    expect(fileStats?.reconstructionTainted).toBe(false);
  });

  it('is true when fs.external_change was recorded', async () => {
    const index = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'fs.external_change',
              data: {
                path: '/src/app.py',
                old_hash: 'aaa',
                new_hash: 'bbb',
                diff_size: 5,
              },
            },
          ],
        },
      ],
    });
    const stats = computeStats(index);

    const fileStats = stats.perFile.get('/src/app.py');
    expect(fileStats?.reconstructionTainted).toBe(true);
  });

  it('is true when a large paste (no content) was recorded', async () => {
    const index = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'paste',
              data: {
                path: '/src/big.py',
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                length: 9000,
                sha256: 'xxx',
                // No content → large paste → tainted.
              },
            },
          ],
        },
      ],
    });
    const stats = computeStats(index);

    const fileStats = stats.perFile.get('/src/big.py');
    expect(fileStats?.reconstructionTainted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// active / idle
// ---------------------------------------------------------------------------

describe('computeStats — active/idle time', () => {
  it('active time is the sum of sub-60s gaps', async () => {
    // Default bundle: events are 10s apart → all gaps are active.
    // Session 0: 1 start + 3 changes = 4 events, 3 gaps × 10s = 30s.
    const index = await buildAndIndex({ sessions: [{ eventCount: 3 }] });
    const stats = computeStats(index);

    // 3 gaps of 10000ms each = 30000ms active, 0 idle.
    expect(stats.totalActiveMs).toBe(30_000);
    expect(stats.totalIdleMs).toBe(0);
  });

  it('idle time captures gaps >=60s', async () => {
    // Manually craft an explicit-events bundle with a 120s gap.
    const base = 1767225600000; // 2026-01-01T00:00:00.000Z
    const w0 = new Date(base).toISOString();
    const w1 = new Date(base + 120_000).toISOString(); // +120s = idle

    const index = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'doc.change',
              data: {
                path: '/f.py',
                deltas: [],
                source: 'typed',
              },
              wall: w0,
            },
            {
              kind: 'doc.change',
              data: {
                path: '/f.py',
                deltas: [],
                source: 'typed',
              },
              wall: w1,
            },
          ],
        },
      ],
    });
    const stats = computeStats(index);

    // The 120s gap is idle. The 10s gap between session.start and first event is active.
    expect(stats.totalIdleMs).toBeGreaterThan(0);
    // The 120s interval should appear in totalIdleMs.
    expect(stats.totalIdleMs).toBeGreaterThanOrEqual(120_000);
  });

  it('mixed active and idle gaps are both counted', async () => {
    const base = 1767225600000;
    const w0 = new Date(base).toISOString();
    const w1 = new Date(base + 10_000).toISOString(); // +10s = active
    const w2 = new Date(base + 10_000 + 90_000).toISOString(); // +90s from w1 = idle

    const index = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'doc.change',
              data: { path: '/f.py', deltas: [], source: 'typed' },
              wall: w0,
            },
            {
              kind: 'doc.change',
              data: { path: '/f.py', deltas: [], source: 'typed' },
              wall: w1,
            },
            {
              kind: 'doc.change',
              data: { path: '/f.py', deltas: [], source: 'typed' },
              wall: w2,
            },
          ],
        },
      ],
    });
    const stats = computeStats(index);

    // Active: 10s between first and second doc.change.
    // Idle: 90s between second and third.
    // (Plus session.start → first doc.change gap, which auto-increments 10s.)
    expect(stats.totalActiveMs).toBeGreaterThanOrEqual(10_000);
    expect(stats.totalIdleMs).toBeGreaterThanOrEqual(90_000);
  });
});

// ---------------------------------------------------------------------------
// terminalOpenDurations
// ---------------------------------------------------------------------------

describe('computeStats — terminalOpenDurations', () => {
  it('returns empty array when no terminal events', async () => {
    const index = await buildAndIndex({ sessions: [{ eventCount: 2 }] });
    const stats = computeStats(index);
    expect(stats.terminalOpenDurations).toHaveLength(0);
  });

  it('records terminal open with null openMs when no close event exists', async () => {
    const index = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'terminal.open',
              data: {
                terminal_id: 'term-1',
                shell: '/bin/bash',
                shell_integration: false,
              },
            },
          ],
        },
      ],
    });
    const stats = computeStats(index);

    expect(stats.terminalOpenDurations).toHaveLength(1);
    expect(stats.terminalOpenDurations[0]?.terminalId).toBe('term-1');
    expect(stats.terminalOpenDurations[0]?.openMs).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// perFile — hand-computed values
// ---------------------------------------------------------------------------

describe('computeStats — hand-computed per-file stats', () => {
  it('matches hand-computed charsTyped for a known sequence', async () => {
    // 'hello' = 5 chars, 'world' = 5 chars, ' ' = 1 char → total = 11
    const index = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'doc.change',
              data: {
                path: '/known.py',
                deltas: [
                  {
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                    text: 'hello',
                  },
                ],
                source: 'typed',
              },
            },
            {
              kind: 'doc.change',
              data: {
                path: '/known.py',
                deltas: [
                  {
                    range: { start: { line: 0, character: 5 }, end: { line: 0, character: 5 } },
                    text: ' ',
                  },
                  {
                    range: { start: { line: 0, character: 6 }, end: { line: 0, character: 6 } },
                    text: 'world',
                  },
                ],
                source: 'typed',
              },
            },
          ],
        },
      ],
    });

    const stats = computeStats(index);
    const fileStats = stats.perFile.get('/known.py');
    expect(fileStats?.charsTyped).toBe(11); // 5 + 1 + 5
  });
});
