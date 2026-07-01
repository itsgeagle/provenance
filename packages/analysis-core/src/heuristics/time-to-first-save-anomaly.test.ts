/**
 * Tests for the time_to_first_save_anomaly heuristic (Phase 16).
 */

import { describe, it, expect } from 'vitest';
import { timeToFirstSaveAnomalyHeuristic } from './time-to-first-save-anomaly.js';
import { buildIndex } from '../index/build-index.js';
import { loadBundle } from '../loader/parse-bundle.js';
import { buildTestBundle } from '../test-support/build-test-bundle.js';
import { DEFAULT_HEURISTIC_CONFIG } from './config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function buildAndIndex(opts: Parameters<typeof buildTestBundle>[0]) {
  const { zipBuffer } = await buildTestBundle(opts);
  const result = await loadBundle(new Blob([zipBuffer]), 'test.zip');
  if (!result.ok) throw new Error(`Bundle load failed: ${JSON.stringify(result.error)}`);
  return { index: buildIndex(result.value), bundle: result.value };
}

const cfg = DEFAULT_HEURISTIC_CONFIG;
// t=1000ms = 1s per event step in explicit events.

// ---------------------------------------------------------------------------
// Positive: open → save in <30s with >500 chars
// ---------------------------------------------------------------------------

describe('time_to_first_save_anomaly — positive', () => {
  it('flags a save that arrives <30s after doc.open with >500 chars', async () => {
    // Build: doc.open at t=0 (seq 1) → paste 600 chars → doc.save at t=5000 (5s)
    const content = 'x'.repeat(600);

    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'doc.open',
              data: { path: '/hw/hw1.py', sha256: 'a'.repeat(64), line_count: 0 },
              t: 0,
            },
            {
              kind: 'paste',
              data: {
                path: '/hw/hw1.py',
                content,
                length: content.length,
                sha256: 'b'.repeat(64),
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              },
              t: 2000,
            },
            {
              kind: 'doc.save',
              data: { path: '/hw/hw1.py', sha256: 'c'.repeat(64) },
              t: 5000, // 5 seconds after open → anomalous
            },
          ],
        },
      ],
    });

    const flags = timeToFirstSaveAnomalyHeuristic.run(index, bundle, cfg);
    expect(flags.length).toBeGreaterThanOrEqual(1);

    const flag = flags[0]!;
    expect(flag.heuristic).toBe('time_to_first_save_anomaly');
    expect(flag.severity).toBe('high');
    expect(flag.confidence).toBe(0.8);
    expect(flag.detail!['elapsedMs']).toBe(5000);
    expect(flag.detail!['contentLength'] as number).toBeGreaterThan(500);
    // Both open and save are in supportingSeqs
    expect(flag.supportingSeqs).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Negative: does not flag when elapsed ≥30s or content ≤500 chars
// ---------------------------------------------------------------------------

describe('time_to_first_save_anomaly — negative', () => {
  it('does not flag when elapsed time is ≥30s', async () => {
    const content = 'x'.repeat(600);

    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'doc.open',
              data: { path: '/hw/hw1.py', sha256: 'a'.repeat(64), line_count: 0 },
              t: 0,
            },
            {
              kind: 'paste',
              data: {
                path: '/hw/hw1.py',
                content,
                length: content.length,
                sha256: 'b'.repeat(64),
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              },
              t: 5000,
            },
            {
              kind: 'doc.save',
              data: { path: '/hw/hw1.py', sha256: 'c'.repeat(64) },
              t: 35000, // 35s → not anomalous
            },
          ],
        },
      ],
    });

    const flags = timeToFirstSaveAnomalyHeuristic.run(index, bundle, cfg);
    expect(flags.filter((f) => f.heuristic === 'time_to_first_save_anomaly')).toHaveLength(0);
  });

  it('does not flag when content ≤500 chars even if fast', async () => {
    // Only 300 chars — below minChars=500
    const content = 'x'.repeat(300);

    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'doc.open',
              data: { path: '/hw/hw1.py', sha256: 'a'.repeat(64), line_count: 0 },
              t: 0,
            },
            {
              kind: 'paste',
              data: {
                path: '/hw/hw1.py',
                content,
                length: content.length,
                sha256: 'b'.repeat(64),
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              },
              t: 2000,
            },
            {
              kind: 'doc.save',
              data: { path: '/hw/hw1.py', sha256: 'c'.repeat(64) },
              t: 5000,
            },
          ],
        },
      ],
    });

    const flags = timeToFirstSaveAnomalyHeuristic.run(index, bundle, cfg);
    expect(flags.filter((f) => f.heuristic === 'time_to_first_save_anomaly')).toHaveLength(0);
  });

  it('does not flag when there is no doc.save in the same session after doc.open', async () => {
    const content = 'x'.repeat(600);

    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'doc.open',
              data: { path: '/hw/hw1.py', sha256: 'a'.repeat(64), line_count: 0 },
              t: 0,
            },
            {
              kind: 'paste',
              data: {
                path: '/hw/hw1.py',
                content,
                length: content.length,
                sha256: 'b'.repeat(64),
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              },
              t: 2000,
            },
            // No doc.save
          ],
        },
      ],
    });

    const flags = timeToFirstSaveAnomalyHeuristic.run(index, bundle, cfg);
    expect(flags.filter((f) => f.heuristic === 'time_to_first_save_anomaly')).toHaveLength(0);
  });

  it('produces no flags for a normal session with no file events', async () => {
    const { index, bundle } = await buildAndIndex({ sessions: [{ eventCount: 3 }] });
    const flags = timeToFirstSaveAnomalyHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(0);
  });
});
