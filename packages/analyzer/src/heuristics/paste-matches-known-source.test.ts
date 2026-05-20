/**
 * Tests for the paste_matches_known_source heuristic and corpus loader (Phase 16).
 */

import { describe, it, expect } from 'vitest';
import {
  pasteMatchesKnownSourceHeuristic,
  loadKnownSourceCorpus,
} from './paste-matches-known-source.js';
import { buildIndex } from '../index/build-index.js';
import { loadBundle } from '../loader/parse-bundle.js';
import { buildTestBundle } from '../../test/helpers/build-test-bundle.js';
import { DEFAULT_HEURISTIC_CONFIG } from './config.js';
import type { HeuristicConfig } from './config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function buildAndIndex(opts: Parameters<typeof buildTestBundle>[0]) {
  const { zipBuffer } = await buildTestBundle(opts);
  const result = await loadBundle(new Blob([zipBuffer]), 'test.zip');
  if (!result.ok) throw new Error(`Bundle load failed: ${JSON.stringify(result.error)}`);
  return { index: buildIndex(result.value), bundle: result.value };
}

// ---------------------------------------------------------------------------
// corpus loader: valid inputs
// ---------------------------------------------------------------------------

describe('loadKnownSourceCorpus — valid', () => {
  it('parses an empty array', () => {
    const result = loadKnownSourceCorpus([]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([]);
  });

  it('parses a valid entry with hashes only', () => {
    const corpus = [{ name: 'hw1 solution', hashes: ['abc123', 'def456'] }];
    const result = loadKnownSourceCorpus(corpus);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value[0]!.name).toBe('hw1 solution');
      expect(result.value[0]!.hashes).toEqual(['abc123', 'def456']);
      expect(result.value[0]!.fuzzy_lines).toBeUndefined();
    }
  });

  it('parses a valid entry with fuzzy_lines', () => {
    const corpus = [
      {
        name: 'hw1 solution',
        hashes: [],
        fuzzy_lines: [['def solve():', '    return 42'], ['# common boilerplate']],
      },
    ];
    const result = loadKnownSourceCorpus(corpus);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value[0]!.fuzzy_lines).toHaveLength(2);
    }
  });
});

// ---------------------------------------------------------------------------
// corpus loader: malformed inputs
// ---------------------------------------------------------------------------

describe('loadKnownSourceCorpus — malformed', () => {
  it('rejects a non-array top-level value', () => {
    const result = loadKnownSourceCorpus({ name: 'oops' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('corpus_error');
  });

  it('rejects an entry that is not an object', () => {
    const result = loadKnownSourceCorpus(['not_an_object']);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.entryIndex).toBe(0);
  });

  it('rejects an entry missing the name field', () => {
    const result = loadKnownSourceCorpus([{ hashes: [] }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/name/);
  });

  it('rejects an entry missing the hashes array', () => {
    const result = loadKnownSourceCorpus([{ name: 'test' }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/hashes/);
  });

  it('rejects an entry with a non-string hash value', () => {
    const result = loadKnownSourceCorpus([{ name: 'test', hashes: [123] }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/hashes/);
  });

  it('rejects an entry with fuzzy_lines that is not an array', () => {
    const result = loadKnownSourceCorpus([{ name: 'test', hashes: [], fuzzy_lines: 'oops' }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/fuzzy_lines/);
  });

  it('rejects null top-level', () => {
    const result = loadKnownSourceCorpus(null);
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Heuristic: positive (exact hash match)
// ---------------------------------------------------------------------------

describe('paste_matches_known_source — positive (hash match)', () => {
  it('flags a paste whose sha256 matches a corpus entry', async () => {
    const knownHash = 'a'.repeat(64);
    const cfgWithCorpus: HeuristicConfig = {
      ...DEFAULT_HEURISTIC_CONFIG,
      pasteMatchesKnownSource: {
        fuzzyThreshold: 0.7,
        corpus: [{ name: 'hw1 solution', hashes: [knownHash] }],
      },
    };

    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'paste',
              data: {
                path: '/hw/hw1.py',
                length: 100,
                sha256: knownHash, // exact match
                content: 'def solve():\n    return 42\n',
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              },
            },
          ],
        },
      ],
    });

    const flags = pasteMatchesKnownSourceHeuristic.run(index, bundle, cfgWithCorpus);
    expect(flags.length).toBeGreaterThanOrEqual(1);

    const flag = flags[0]!;
    expect(flag.heuristic).toBe('paste_matches_known_source');
    expect(flag.severity).toBe('high');
    expect(flag.confidence).toBe(0.95);
    expect(flag.detail!['matchKind']).toBe('hash_exact');
    expect(flag.detail!['sourceName']).toBe('hw1 solution');
  });
});

// ---------------------------------------------------------------------------
// Heuristic: positive (fuzzy line match)
// ---------------------------------------------------------------------------

describe('paste_matches_known_source — positive (fuzzy match)', () => {
  it('flags a paste that fuzzy-matches a corpus entry above the threshold', async () => {
    // Paste content: 4 lines exactly matching the reference block → 100% > 70%.
    // fuzzy_lines elements are joined with '\n' internally; we match exactly.
    const pasteContent = 'def solve():\n    n = int(input())\n    return n * 2\n';
    // Reference block (string[]) will be joined with '\n' in fuzzyLineRatio.
    // 'def solve():\n    n = int(input())\n    return n * 2\n' → exact same text.
    const referenceBlock = ['def solve():', '    n = int(input())', '    return n * 2', ''];

    const cfgWithCorpus: HeuristicConfig = {
      ...DEFAULT_HEURISTIC_CONFIG,
      pasteMatchesKnownSource: {
        fuzzyThreshold: 0.7,
        corpus: [
          {
            name: 'hw1 common snippet',
            hashes: [], // no exact hash
            fuzzy_lines: [referenceBlock],
          },
        ],
      },
    };

    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'paste',
              data: {
                path: '/hw/hw1.py',
                length: pasteContent.length,
                sha256: 'b'.repeat(64),
                content: pasteContent,
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              },
            },
          ],
        },
      ],
    });

    const flags = pasteMatchesKnownSourceHeuristic.run(index, bundle, cfgWithCorpus);
    expect(flags.length).toBeGreaterThanOrEqual(1);

    const flag = flags[0]!;
    expect(flag.severity).toBe('medium');
    expect(flag.confidence).toBe(0.8);
    expect(flag.detail!['matchKind']).toBe('fuzzy_lines');
  });
});

// ---------------------------------------------------------------------------
// Heuristic: negative
// ---------------------------------------------------------------------------

describe('paste_matches_known_source — negative', () => {
  it('emits no flags when corpus is empty', async () => {
    // DEFAULT_HEURISTIC_CONFIG has corpus: [] → no flags
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'paste',
              data: {
                path: '/hw/hw1.py',
                length: 200,
                sha256: 'c'.repeat(64),
                content: 'def solve():\n    return 42\n',
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              },
            },
          ],
        },
      ],
    });

    const flags = pasteMatchesKnownSourceHeuristic.run(index, bundle, DEFAULT_HEURISTIC_CONFIG);
    expect(flags.filter((f) => f.heuristic === 'paste_matches_known_source')).toHaveLength(0);
  });

  it('does not flag a paste with a non-matching sha256', async () => {
    const cfgWithCorpus: HeuristicConfig = {
      ...DEFAULT_HEURISTIC_CONFIG,
      pasteMatchesKnownSource: {
        fuzzyThreshold: 0.7,
        corpus: [{ name: 'hw1 solution', hashes: ['a'.repeat(64)] }],
      },
    };

    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'paste',
              data: {
                path: '/hw/hw1.py',
                length: 50,
                sha256: 'b'.repeat(64), // different hash
                content: 'student_unique_code()',
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              },
            },
          ],
        },
      ],
    });

    const flags = pasteMatchesKnownSourceHeuristic.run(index, bundle, cfgWithCorpus);
    expect(flags.filter((f) => f.heuristic === 'paste_matches_known_source')).toHaveLength(0);
  });

  it('does not flag a paste that shares <70% lines with the fuzzy block', async () => {
    const pasteContent = 'completely_different_1\ncompletely_different_2\ncompletely_different_3';
    const referenceBlock = ['hw_solution_line1', 'hw_solution_line2', 'hw_solution_line3'];

    const cfgWithCorpus: HeuristicConfig = {
      ...DEFAULT_HEURISTIC_CONFIG,
      pasteMatchesKnownSource: {
        fuzzyThreshold: 0.7,
        corpus: [{ name: 'hw1 snippet', hashes: [], fuzzy_lines: [referenceBlock] }],
      },
    };

    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'paste',
              data: {
                path: '/hw/hw1.py',
                length: pasteContent.length,
                sha256: 'c'.repeat(64),
                content: pasteContent,
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              },
            },
          ],
        },
      ],
    });

    const flags = pasteMatchesKnownSourceHeuristic.run(index, bundle, cfgWithCorpus);
    expect(flags.filter((f) => f.heuristic === 'paste_matches_known_source')).toHaveLength(0);
  });

  it('produces no flags when there are no paste events', async () => {
    const cfgWithCorpus: HeuristicConfig = {
      ...DEFAULT_HEURISTIC_CONFIG,
      pasteMatchesKnownSource: {
        fuzzyThreshold: 0.7,
        corpus: [{ name: 'hw1 solution', hashes: ['a'.repeat(64)] }],
      },
    };

    const { index, bundle } = await buildAndIndex({ sessions: [{ eventCount: 3 }] });
    const flags = pasteMatchesKnownSourceHeuristic.run(index, bundle, cfgWithCorpus);
    expect(flags).toHaveLength(0);
  });
});
