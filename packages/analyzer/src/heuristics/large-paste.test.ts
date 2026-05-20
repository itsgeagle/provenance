/**
 * Tests for the large_paste heuristic (Phase 4).
 */

import { describe, it, expect } from 'vitest';
import { largePasteHeuristic } from './large-paste.js';
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
// Negative: no paste events → no flags
// ---------------------------------------------------------------------------

describe('large_paste — negative', () => {
  it('produces no flags when there are no paste events', async () => {
    const { index, bundle } = await buildAndIndex({ sessions: [{ eventCount: 3 }] });
    const flags = largePasteHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(0);
  });

  it('produces no flags for a small paste (below both thresholds)', async () => {
    // 50-char, 1-line paste — below minChars=200 and minLines=10
    const content = 'a'.repeat(50);
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
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 0, character: 0 },
                },
              },
            },
          ],
        },
      ],
    });
    const flags = largePasteHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(0);
  });

  it('does not flag a paste of exactly 199 chars (below minChars)', async () => {
    const content = 'a'.repeat(199);
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
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 0, character: 0 },
                },
              },
            },
          ],
        },
      ],
    });
    const flags = largePasteHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(0);
  });

  it('does not flag a 9-line paste without enough chars', async () => {
    const content = 'x\n'.repeat(9).trimEnd(); // 9 lines, 18 chars
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
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 0, character: 0 },
                },
              },
            },
          ],
        },
      ],
    });
    const flags = largePasteHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Positive: char threshold
// ---------------------------------------------------------------------------

describe('large_paste — positive (char threshold)', () => {
  it('flags a paste of exactly 200 chars (at minChars boundary)', async () => {
    const content = 'a'.repeat(200);
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
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 0, character: 0 },
                },
              },
            },
          ],
        },
      ],
    });
    const flags = largePasteHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.heuristic).toBe('large_paste');
    expect(flags[0]!.severity).toBe('medium');
    expect(flags[0]!.confidence).toBe(0.8);
    expect(flags[0]!.detail!['charCount']).toBe(200);
  });

  it('flags a paste of 500 chars as high severity', async () => {
    const content = 'a'.repeat(500);
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
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 0, character: 0 },
                },
              },
            },
          ],
        },
      ],
    });
    const flags = largePasteHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe('high');
  });

  it('flags a paste of 499 chars as medium severity', async () => {
    const content = 'a'.repeat(499);
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
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 0, character: 0 },
                },
              },
            },
          ],
        },
      ],
    });
    const flags = largePasteHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe('medium');
  });
});

// ---------------------------------------------------------------------------
// Positive: line threshold
// ---------------------------------------------------------------------------

describe('large_paste — positive (line threshold)', () => {
  it('flags a 10-line paste (at minLines boundary) by line count', async () => {
    // 10 lines but < 200 chars → triggered by line threshold
    const content = Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n');
    expect(content.split('\n').length).toBe(10);
    expect(content.length).toBeLessThan(200);

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
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 0, character: 0 },
                },
              },
            },
          ],
        },
      ],
    });
    const flags = largePasteHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe('medium');
    expect(flags[0]!.detail!['lineCount']).toBe(10);
  });

  it('flags a 30-line paste as high severity', async () => {
    const content = Array.from({ length: 30 }, (_, i) => `line_content_${i}`).join('\n');
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
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 0, character: 0 },
                },
              },
            },
          ],
        },
      ],
    });
    const flags = largePasteHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe('high');
  });

  it('flags a 29-line paste as medium severity (below high-severity boundary)', async () => {
    // 29 lines with ≥200 chars total → flagged as medium (not high)
    const content = Array.from({ length: 29 }, (_, i) => `line_content_${i}`).join('\n');
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
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 0, character: 0 },
                },
              },
            },
          ],
        },
      ],
    });
    const flags = largePasteHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe('medium');
  });
});

// ---------------------------------------------------------------------------
// Multiple pastes → multiple flags
// ---------------------------------------------------------------------------

describe('large_paste — multiple pastes', () => {
  it('emits one flag per qualifying paste', async () => {
    const smallPaste = 'a'.repeat(50); // below threshold
    const largePaste1 = 'b'.repeat(200); // medium
    const largePaste2 = 'c'.repeat(600); // high

    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'paste',
              data: {
                path: '/test/a.py',
                content: smallPaste,
                length: smallPaste.length,
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              },
            },
            {
              kind: 'paste',
              data: {
                path: '/test/b.py',
                content: largePaste1,
                length: largePaste1.length,
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              },
            },
            {
              kind: 'paste',
              data: {
                path: '/test/c.py',
                content: largePaste2,
                length: largePaste2.length,
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              },
            },
          ],
        },
      ],
    });
    const flags = largePasteHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(2);
    // One medium, one high.
    const severities = flags.map((f) => f.severity).sort();
    expect(severities).toEqual(['high', 'medium']);
  });
});

// ---------------------------------------------------------------------------
// Flag ID is deterministic
// ---------------------------------------------------------------------------

describe('large_paste — flag ID is deterministic', () => {
  it('produces the same flag ids across two identical runs', async () => {
    const content = 'a'.repeat(200);
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
    const flags1 = largePasteHeuristic.run(index, bundle, cfg);
    const flags2 = largePasteHeuristic.run(index, bundle, cfg);
    expect(flags1.map((f) => f.id)).toEqual(flags2.map((f) => f.id));
  });
});

// ---------------------------------------------------------------------------
// Large paste without content field (large paste > 4KB, no inline content)
// ---------------------------------------------------------------------------

describe('large_paste — paste without inline content', () => {
  it('flags a large paste using only the length field when content is absent', async () => {
    // Simulates a paste > 4 KB where the recorder only stores length/sha256,
    // not the full content. We can still flag by char count.
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'paste',
              data: {
                path: '/test/file.py',
                // No 'content' field — large paste
                length: 5000,
                sha256: 'abc'.repeat(21) + 'ab',
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              },
            },
          ],
        },
      ],
    });
    const flags = largePasteHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe('high'); // > 500 chars
    // Line count should be null when content is absent
    expect(flags[0]!.detail!['lineCount']).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// paste.anomaly window reduces confidence
// ---------------------------------------------------------------------------

describe('large_paste — anomaly window', () => {
  it('reduces confidence to 0.6 when paste is near a paste.anomaly event', async () => {
    const content = 'a'.repeat(200);
    // paste at t=1000, paste.anomaly at t=2000 → within 5000ms window
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
              t: 1000,
            },
            {
              kind: 'paste.anomaly',
              data: { path: '/test/file.py', reason: 'no_selection_change' },
              t: 2000,
            },
          ],
        },
      ],
    });
    const flags = largePasteHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.confidence).toBe(0.6);
    expect(flags[0]!.detail!['inAnomalyWindow']).toBe(true);
  });

  it('keeps confidence at 0.8 when paste.anomaly is outside the 5s window', async () => {
    const content = 'a'.repeat(200);
    // paste at t=1000, paste.anomaly at t=8000 → 7 seconds apart, outside window
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
              t: 1000,
            },
            {
              kind: 'paste.anomaly',
              data: { path: '/test/file.py', reason: 'no_selection_change' },
              t: 8000,
            },
          ],
        },
      ],
    });
    const flags = largePasteHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.confidence).toBe(0.8);
  });
});

// ---------------------------------------------------------------------------
// Custom config thresholds
// ---------------------------------------------------------------------------

describe('large_paste — custom thresholds', () => {
  it('respects custom minChars threshold', async () => {
    const content = 'a'.repeat(100); // 100 chars — below default 200 but above custom 50
    const customConfig = {
      ...DEFAULT_HEURISTIC_CONFIG,
      largePaste: { ...DEFAULT_HEURISTIC_CONFIG.largePaste, minChars: 50 },
    };
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
    const flags = largePasteHeuristic.run(index, bundle, customConfig);
    expect(flags).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Recorder v1.2: paste-shaped doc.change events should also flag
// ---------------------------------------------------------------------------

describe('large_paste — paste-shaped doc.change (recorder v1.2)', () => {
  it('flags a doc.change with source=paste_likely whose delta is ≥ minChars (replacement edit)', async () => {
    // Real-world shape from a Claude Code "Apply" against hello.py:
    //   one delta, ~722 chars, replacing L6C0..L10C0. Range non-empty so the
    //   recorder writes it as a doc.change (not a paste event) with
    //   source=paste_likely.
    const text = "    elif op == '-':\n        return num1 - num2\n".repeat(20); // ≈ 940 chars
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'doc.change',
              data: {
                path: 'hello.py',
                deltas: [
                  {
                    range: {
                      start: { line: 6, character: 0 },
                      end: { line: 10, character: 0 },
                    },
                    text,
                  },
                ],
                source: 'paste_likely',
              },
            },
          ],
        },
      ],
    });
    const flags = largePasteHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe('high'); // 940 chars ≥ highSeverityChars default
    expect(flags[0]!.detail!['origin']).toBe('doc.change');
    expect(flags[0]!.detail!['charCount']).toBe(text.length);
    expect(flags[0]!.description).toMatch(/paste-shaped bulk edit/);
  });

  it('flags each delta of a multi-delta paste_likely WorkspaceEdit separately', async () => {
    // Two deltas, each large enough on its own → two flags.
    const text1 = 'x'.repeat(250);
    const text2 = 'y'.repeat(300);
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'doc.change',
              data: {
                path: 'hello.py',
                deltas: [
                  {
                    range: {
                      start: { line: 0, character: 0 },
                      end: { line: 0, character: 0 },
                    },
                    text: text1,
                  },
                  {
                    range: {
                      start: { line: 5, character: 0 },
                      end: { line: 5, character: 0 },
                    },
                    text: text2,
                  },
                ],
                source: 'paste_likely',
              },
            },
          ],
        },
      ],
    });
    const flags = largePasteHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(2);
    for (const f of flags) {
      expect(f.detail!['origin']).toBe('doc.change');
    }
  });

  it('does NOT flag a doc.change whose source is "typed" even when delta is large', async () => {
    // Regression: source='typed' must remain unflagged. Otherwise a student
    // typing fast loses the distinction.
    const text = 'x'.repeat(500);
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'doc.change',
              data: {
                path: 'hello.py',
                deltas: [
                  {
                    range: {
                      start: { line: 0, character: 0 },
                      end: { line: 0, character: 0 },
                    },
                    text,
                  },
                ],
                source: 'typed',
              },
            },
          ],
        },
      ],
    });
    const flags = largePasteHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(0);
  });
});
