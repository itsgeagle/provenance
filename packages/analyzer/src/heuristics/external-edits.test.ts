/**
 * Tests for the external_edits heuristic (Phase 4).
 */

import { describe, it, expect } from 'vitest';
import { externalEditsHeuristic } from './external-edits.js';
import { buildIndex } from '../index/build-index.js';
import { loadBundle } from '../loader/parse-bundle.js';
import { buildTestBundle } from '../../test/helpers/build-test-bundle.js';
import { DEFAULT_HEURISTIC_CONFIG } from './config.js';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

async function buildAndIndex(opts: Parameters<typeof buildTestBundle>[0]) {
  const { zipBuffer } = await buildTestBundle(opts);
  const result = await loadBundle(new Blob([zipBuffer]), 'test.zip');
  if (!result.ok) throw new Error(`Bundle load failed: ${JSON.stringify(result.error)}`);
  return { index: buildIndex(result.value), bundle: result.value };
}

const cfg = DEFAULT_HEURISTIC_CONFIG;

// ---------------------------------------------------------------------------
// Negative: no external change events
// ---------------------------------------------------------------------------

describe('external_edits — negative', () => {
  it('produces no flags when there are no fs.external_change events', async () => {
    const { index, bundle } = await buildAndIndex({ sessions: [{ eventCount: 3 }] });
    const flags = externalEditsHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(0);
  });

  it('produces no flags when all external changes have formatter explanation', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'fs.external_change',
              data: {
                path: '/test/file.py',
                explanation: 'formatter',
                diff_size: 50,
              },
            },
          ],
        },
      ],
    });
    const flags = externalEditsHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(0);
  });

  it('produces no flags when all external changes have git explanation', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'fs.external_change',
              data: {
                path: '/test/file.py',
                explanation: 'git',
                diff_size: 200,
              },
            },
          ],
        },
      ],
    });
    const flags = externalEditsHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Positive: unexplained external changes
// ---------------------------------------------------------------------------

describe('external_edits — positive', () => {
  it('flags a single unexplained fs.external_change as medium severity', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'fs.external_change',
              data: {
                path: '/test/file.py',
                diff_size: 50, // below highSeverityCharsChanged (100)
              },
            },
          ],
        },
      ],
    });
    const flags = externalEditsHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.heuristic).toBe('external_edits');
    expect(flags[0]!.severity).toBe('medium');
    expect(flags[0]!.confidence).toBe(0.9);
  });

  it('flags an unexplained external change with diff_size > 100 as high severity', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'fs.external_change',
              data: {
                path: '/test/file.py',
                diff_size: 101,
              },
            },
          ],
        },
      ],
    });
    const flags = externalEditsHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe('high');
  });

  it('flags an unexplained external change with diff_size exactly 100 as medium', async () => {
    // Boundary: highSeverityCharsChanged is 100, so > 100 is high.
    // Exactly 100 should be medium.
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'fs.external_change',
              data: {
                path: '/test/file.py',
                diff_size: 100,
              },
            },
          ],
        },
      ],
    });
    const flags = externalEditsHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe('medium');
  });

  it('flags an external change with no explanation field', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'fs.external_change',
              data: {
                path: '/test/file.py',
                // No explanation field
              },
            },
          ],
        },
      ],
    });
    const flags = externalEditsHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(1);
  });

  it('does not flag an external change with explanation: "formatter" even with large diff', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'fs.external_change',
              data: {
                path: '/test/file.py',
                explanation: 'formatter',
                diff_size: 9999,
              },
            },
          ],
        },
      ],
    });
    const flags = externalEditsHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Coalescing: consecutive events within 2s window → single flag
// ---------------------------------------------------------------------------

describe('external_edits — coalescing', () => {
  it('coalesces 5 external changes within 2s on the same file into 1 flag', async () => {
    // All events at t=1000, 1500, 1800, 2000, 2900ms — within 2000ms of each other.
    // BUT coalescing is per consecutive pair. Let's ensure all are within 2s apart.
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'fs.external_change',
              data: { path: '/test/file.py', diff_size: 10 },
              t: 1000,
            },
            {
              kind: 'fs.external_change',
              data: { path: '/test/file.py', diff_size: 10 },
              t: 2000,
            },
            {
              kind: 'fs.external_change',
              data: { path: '/test/file.py', diff_size: 10 },
              t: 3000,
            },
            {
              kind: 'fs.external_change',
              data: { path: '/test/file.py', diff_size: 10 },
              t: 4000,
            },
            {
              kind: 'fs.external_change',
              data: { path: '/test/file.py', diff_size: 10 },
              t: 5000,
            },
          ],
        },
      ],
    });
    const flags = externalEditsHeuristic.run(index, bundle, cfg);
    // All consecutive pairs are 1000ms apart (< 2000ms window) → 1 flag
    expect(flags).toHaveLength(1);
    expect(flags[0]!.detail!['eventCount']).toBe(5);
  });

  it('splits into 2 flags when a burst spans > 2s gap', async () => {
    // Events at t=1000, 2000, 5000 (gap of 3000ms between 2nd and 3rd)
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'fs.external_change',
              data: { path: '/test/file.py', diff_size: 10 },
              t: 1000,
            },
            {
              kind: 'fs.external_change',
              data: { path: '/test/file.py', diff_size: 10 },
              t: 2000,
            },
            {
              kind: 'fs.external_change',
              data: { path: '/test/file.py', diff_size: 10 },
              t: 5001, // 3001ms gap from previous → new group
            },
          ],
        },
      ],
    });
    const flags = externalEditsHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(2);
    const counts = flags.map((f) => f.detail!['eventCount'] as number);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(3);
  });

  it('does not coalesce events on different files', async () => {
    // Two simultaneous external changes on different files → 2 flags
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'fs.external_change',
              data: { path: '/test/a.py', diff_size: 10 },
              t: 1000,
            },
            {
              kind: 'fs.external_change',
              data: { path: '/test/b.py', diff_size: 10 },
              t: 1000,
            },
          ],
        },
      ],
    });
    const flags = externalEditsHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(2);
  });

  it('does not coalesce events across sessions (t is session-local)', async () => {
    // Two events on the same file, both at t=1000 but in different sessions.
    // They cannot be coalesced because t is session-local.
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'fs.external_change',
              data: { path: '/test/file.py', diff_size: 10 },
              t: 1000,
            },
          ],
        },
        {
          events: [
            {
              kind: 'fs.external_change',
              data: { path: '/test/file.py', diff_size: 10 },
              t: 1000,
            },
          ],
        },
      ],
    });
    const flags = externalEditsHeuristic.run(index, bundle, cfg);
    // Different sessions → 2 flags
    expect(flags).toHaveLength(2);
  });

  it('uses maximum diff_size for severity when coalescing', async () => {
    // Two events within 2s: one small, one large
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'fs.external_change',
              data: { path: '/test/file.py', diff_size: 10 },
              t: 1000,
            },
            {
              kind: 'fs.external_change',
              data: { path: '/test/file.py', diff_size: 200 },
              t: 2000,
            },
          ],
        },
      ],
    });
    const flags = externalEditsHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(1);
    // maxDiffSize is 200 > 100 → high
    expect(flags[0]!.severity).toBe('high');
    expect(flags[0]!.detail!['maxDiffSize']).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// supportingSeqs format
// ---------------------------------------------------------------------------

describe('external_edits — supportingSeqs', () => {
  it('includes all event seqs in a coalesced group', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'fs.external_change',
              data: { path: '/test/file.py', diff_size: 10 },
              t: 1000,
            },
            {
              kind: 'fs.external_change',
              data: { path: '/test/file.py', diff_size: 10 },
              t: 1500,
            },
          ],
        },
      ],
    });
    const flags = externalEditsHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(1);
    // Both seq keys should be present
    expect(flags[0]!.supportingSeqs).toHaveLength(2);
    // Both should follow the ${sessionId}:${seq} format
    for (const key of flags[0]!.supportingSeqs) {
      expect(key).toMatch(/^[0-9a-f-]+:\d+$/);
    }
  });
});

// ---------------------------------------------------------------------------
// Mixed: some explained, some not
// ---------------------------------------------------------------------------

describe('external_edits — mixed explained/unexplained', () => {
  it('only flags unexplained events when mix is present', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'fs.external_change',
              data: { path: '/test/file.py', explanation: 'formatter', diff_size: 50 },
              t: 1000,
            },
            {
              kind: 'fs.external_change',
              data: { path: '/test/file.py', diff_size: 50 },
              t: 2000,
            },
          ],
        },
      ],
    });
    const flags = externalEditsHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(1);
  });
});
