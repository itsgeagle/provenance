/**
 * Tests for the low_typing_high_output heuristic (Phase 4).
 */

import { describe, it, expect } from 'vitest';
import { lowTypingHighOutputHeuristic } from './low-typing-high-output.js';
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
// Negative: no flags when ratio is below threshold
// ---------------------------------------------------------------------------

describe('low_typing_high_output — negative', () => {
  it('produces no flags when there are no file events', async () => {
    // A bundle with only session.start and doc.change events on a file
    // where typed == final content (ratio = 1)
    // Build a bundle where charsTyped == content length.
    // Default bundle: inserts 'x1' then 'x2' ... 'x5' → content = 'x5x4x3x2x1'
    // charsTyped = 2+2+2+2+2 = 10, content = 'x5x4x3x2x1' = 10 chars → ratio = 1
    const { index, bundle } = await buildAndIndex({ sessions: [{ eventCount: 5 }] });
    const flags = lowTypingHighOutputHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(0);
  });

  it('produces no flags when the final content is empty', async () => {
    // Only session.start and doc.change that add then delete content
    // (content = '' at end). reconstructFile will give empty string.
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'doc.change',
              data: {
                path: '/test/file.py',
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
                path: '/test/file.py',
                deltas: [
                  {
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
                    text: '',
                  },
                ],
                source: 'typed',
              },
            },
          ],
        },
      ],
    });
    const flags = lowTypingHighOutputHeuristic.run(index, bundle, cfg);
    // Final content = '' → no flag
    expect(flags).toHaveLength(0);
  });

  it('produces no flags for a tainted file (fs.external_change)', async () => {
    // A file with a doc.change and then an fs.external_change taints reconstruction.
    // The heuristic should skip tainted files entirely.
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'doc.change',
              data: {
                path: '/test/file.py',
                deltas: [
                  {
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                    text: 'a',
                  },
                ],
                source: 'typed',
              },
            },
            {
              kind: 'fs.external_change',
              data: { path: '/test/file.py', diff_size: 5000 },
            },
          ],
        },
      ],
    });
    const flags = lowTypingHighOutputHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Positive: ratio >= minRatio
// ---------------------------------------------------------------------------

describe('low_typing_high_output — positive', () => {
  it('flags a file where typed 1 char but final content has 3 chars (ratio=3)', async () => {
    // Type 'a' (1 char inserted), but use a paste to add 'bc' so final = 'abc' (3 chars).
    // ratio = 3 / 1 = 3.0 exactly → should flag (>= minRatio).
    //
    // Construct events: doc.change inserts 'a', then paste inserts 'bc' (small inline paste).
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'doc.change',
              data: {
                path: '/test/file.py',
                deltas: [
                  {
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                    text: 'a',
                  },
                ],
                source: 'typed',
              },
            },
            {
              kind: 'paste',
              data: {
                path: '/test/file.py',
                content: 'bc',
                length: 2,
                range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } },
              },
            },
          ],
        },
      ],
    });
    const flags = lowTypingHighOutputHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.heuristic).toBe('low_typing_high_output');
    expect(flags[0]!.detail!['ratio']).toBeDefined();
    const ratio = flags[0]!.detail!['ratio'] as number;
    expect(ratio).toBeCloseTo(3.0, 1);
  });

  it('flags with medium severity when ratio is in [3, 5)', async () => {
    // Type 1 char, final = 4 chars → ratio 4 (medium bracket)
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'doc.change',
              data: {
                path: '/test/file.py',
                deltas: [
                  {
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                    text: 'a',
                  },
                ],
                source: 'typed',
              },
            },
            {
              kind: 'paste',
              data: {
                path: '/test/file.py',
                content: 'bcd',
                length: 3,
                range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } },
              },
            },
          ],
        },
      ],
    });
    const flags = lowTypingHighOutputHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe('medium');
  });

  it('flags with high severity when ratio >= 5', async () => {
    // Type 1 char, final = 5 chars → ratio 5 (high boundary)
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'doc.change',
              data: {
                path: '/test/file.py',
                deltas: [
                  {
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                    text: 'a',
                  },
                ],
                source: 'typed',
              },
            },
            {
              kind: 'paste',
              data: {
                path: '/test/file.py',
                content: 'bcde',
                length: 4,
                range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } },
              },
            },
          ],
        },
      ],
    });
    const flags = lowTypingHighOutputHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe('high');
  });

  it('does not flag when ratio is exactly below minRatio (< 3)', async () => {
    // Type 2 chars, final = 5 chars → ratio 2.5 (below 3)
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'doc.change',
              data: {
                path: '/test/file.py',
                deltas: [
                  {
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                    text: 'ab',
                  },
                ],
                source: 'typed',
              },
            },
            {
              kind: 'paste',
              data: {
                path: '/test/file.py',
                content: 'cde',
                length: 3,
                range: { start: { line: 0, character: 2 }, end: { line: 0, character: 2 } },
              },
            },
          ],
        },
      ],
    });
    const flags = lowTypingHighOutputHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Edge: charsTyped = 0, final content non-empty → infinite ratio
// ---------------------------------------------------------------------------

describe('low_typing_high_output — infinite ratio (zero typing)', () => {
  it('flags with high severity when nothing was typed but file has content (via paste)', async () => {
    // No doc.change events, only a paste → charsTyped = 0, but file has content
    const content = 'a'.repeat(10); // small paste, not tainted
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'paste',
              data: {
                path: '/test/file.py',
                content,
                length: content.length,
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              },
            },
          ],
        },
      ],
    });
    const flags = lowTypingHighOutputHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe('high');
    // ratio is null/Infinity → detail.ratio is null
    expect(flags[0]!.detail!['ratio']).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Confidence scaling
// ---------------------------------------------------------------------------

describe('low_typing_high_output — confidence', () => {
  it('has lower confidence when charsTyped < minCharsForConfidence', async () => {
    // Type 1 char out of 500 → confidence = 1/500 = 0.002
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'doc.change',
              data: {
                path: '/test/file.py',
                deltas: [
                  {
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                    text: 'a',
                  },
                ],
                source: 'typed',
              },
            },
            {
              kind: 'paste',
              data: {
                path: '/test/file.py',
                content: 'bcde',
                length: 4,
                range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } },
              },
            },
          ],
        },
      ],
    });
    const flags = lowTypingHighOutputHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(1);
    // charsTyped = 1, minCharsForConfidence = 500 → confidence = 1/500 = 0.002
    expect(flags[0]!.confidence).toBeCloseTo(1 / 500, 4);
  });

  it('caps confidence at 1.0 when charsTyped >= minCharsForConfidence', async () => {
    // Type 500 chars, final = 2000 chars → ratio 4, confidence capped at 1.0
    const typedContent = 'a'.repeat(500);
    const pastedContent = 'b'.repeat(1500);
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'doc.change',
              data: {
                path: '/test/file.py',
                deltas: [
                  {
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                    text: typedContent,
                  },
                ],
                source: 'typed',
              },
            },
            {
              kind: 'paste',
              data: {
                path: '/test/file.py',
                content: pastedContent,
                length: pastedContent.length,
                range: {
                  start: { line: 0, character: typedContent.length },
                  end: { line: 0, character: typedContent.length },
                },
              },
            },
          ],
        },
      ],
    });
    const flags = lowTypingHighOutputHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.confidence).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// Per-file scope: separate files get separate flags
// ---------------------------------------------------------------------------

describe('low_typing_high_output — per-file scope', () => {
  it('emits one flag per offending file', async () => {
    // Two files: both have high ratio
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            // File A: type 1 char, paste 4 more → ratio 5
            {
              kind: 'doc.change',
              data: {
                path: '/test/a.py',
                deltas: [
                  {
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                    text: 'a',
                  },
                ],
                source: 'typed',
              },
            },
            {
              kind: 'paste',
              data: {
                path: '/test/a.py',
                content: 'bcde',
                length: 4,
                range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } },
              },
            },
            // File B: type 1 char, paste 4 more → ratio 5
            {
              kind: 'doc.change',
              data: {
                path: '/test/b.py',
                deltas: [
                  {
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                    text: 'x',
                  },
                ],
                source: 'typed',
              },
            },
            {
              kind: 'paste',
              data: {
                path: '/test/b.py',
                content: 'yzwv',
                length: 4,
                range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } },
              },
            },
          ],
        },
      ],
    });
    const flags = lowTypingHighOutputHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(2);
    const files = flags.map((f) => f.detail!['filePath'] as string).sort();
    expect(files).toEqual(['/test/a.py', '/test/b.py']);
  });
});
