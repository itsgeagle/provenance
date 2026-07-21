/**
 * Tests for the internal-move classifier.
 *
 * The load-bearing case is `does NOT launder an external paste`: relocating code
 * that itself arrived by paste must not be classified as an internal move. If
 * that test ever goes green-by-weakening, the classifier has become a way to
 * hide an external paste by moving it between files.
 */

import { describe, it, expect } from 'vitest';
import { classifyInternalMoves, normalizeForMatch } from './internal-move.js';
import { iterateCandidatePastes } from './candidate-pastes.js';
import { buildIndex } from '../index/build-index.js';
import type { EventIndex } from '../index/event-index.js';
import { loadBundle } from '../loader/parse-bundle.js';
import { buildTestBundle } from '../test-support/build-test-bundle.js';
import { DEFAULT_HEURISTIC_CONFIG, mergeConfig } from './config.js';
import type { MoveResult } from './internal-move.js';

async function buildAndIndex(opts: Parameters<typeof buildTestBundle>[0]) {
  const { zipBuffer } = await buildTestBundle(opts);
  const result = await loadBundle(new Blob([zipBuffer]), 'test.zip');
  if (!result.ok) throw new Error(`Bundle load failed: ${JSON.stringify(result.error)}`);
  return buildIndex(result.value);
}

const cfg = DEFAULT_HEURISTIC_CONFIG;

/** A 5-line, >40-char block used as the thing being moved around. */
const BLOCK = [
  'def helper(values):',
  '    total = 0',
  '    for v in values:',
  '        total += v',
  '    return total',
  '',
].join('\n');

function typedInsert(path: string, text: string, line: number) {
  return {
    kind: 'doc.change' as const,
    data: {
      path,
      source: 'typed',
      deltas: [
        {
          range: { start: { line, character: 0 }, end: { line, character: 0 } },
          text,
        },
      ],
    },
  };
}

function pasteEvent(path: string, text: string, line: number) {
  return {
    kind: 'paste' as const,
    data: {
      path,
      content: text,
      length: text.length,
      sha256: 'inline',
      range: { start: { line, character: 0 }, end: { line, character: 0 } },
    },
  };
}

/** Delete `[startLine, endLine)` — a cut. */
function cutLines(path: string, startLine: number, endLine: number) {
  return {
    kind: 'doc.change' as const,
    data: {
      path,
      source: 'typed',
      deltas: [
        {
          range: {
            start: { line: startLine, character: 0 },
            end: { line: endLine, character: 0 },
          },
          text: '',
        },
      ],
    },
  };
}

/** Classification of the Nth candidate paste in iteration order. */
function resultFor(
  index: EventIndex,
  results: Map<number, MoveResult>,
  n: number,
): MoveResult | undefined {
  const candidates = [...iterateCandidatePastes(index)];
  const c = candidates[n];
  if (c === undefined) throw new Error(`no candidate at position ${n}`);
  return results.get(c.ordinal);
}

describe('normalizeForMatch', () => {
  it('strips per-line indentation and blank lines', () => {
    expect(normalizeForMatch('  a\n\n    b\n')).toBe('a\nb');
  });

  it('normalises CRLF', () => {
    expect(normalizeForMatch('a\r\nb')).toBe('a\nb');
  });
});

describe('classifyInternalMoves', () => {
  it("classifies a copy of the student's own typed code as an internal move", async () => {
    const index = await buildAndIndex({
      sessions: [
        {
          events: [
            { kind: 'doc.open', data: { path: '/t/hw.py', content: '' } },
            typedInsert('/t/hw.py', BLOCK, 0),
            pasteEvent('/t/hw.py', BLOCK, 5),
          ],
        },
      ],
    });

    const r = resultFor(index, classifyInternalMoves(index, cfg), 0);
    expect(r?.classification).toBe('internal_move');
    expect(r?.via).toBe('copy');
    expect(r?.sourcePath).toBe('/t/hw.py');
  });

  it('classifies cut-then-paste-back as an internal move via the ledger', async () => {
    const index = await buildAndIndex({
      sessions: [
        {
          events: [
            { kind: 'doc.open', data: { path: '/t/hw.py', content: '' } },
            typedInsert('/t/hw.py', BLOCK, 0),
            cutLines('/t/hw.py', 0, 5),
            pasteEvent('/t/hw.py', BLOCK, 0),
          ],
        },
      ],
    });

    const r = resultFor(index, classifyInternalMoves(index, cfg), 0);
    expect(r?.classification).toBe('internal_move');
    expect(r?.via).toBe('cut');
  });

  it('classifies a cross-file move as an internal move', async () => {
    const index = await buildAndIndex({
      sessions: [
        {
          events: [
            { kind: 'doc.open', data: { path: '/t/utils.py', content: '' } },
            typedInsert('/t/utils.py', BLOCK, 0),
            { kind: 'doc.open', data: { path: '/t/hw.py', content: '' } },
            pasteEvent('/t/hw.py', BLOCK, 0),
          ],
        },
      ],
    });

    const r = resultFor(index, classifyInternalMoves(index, cfg), 0);
    expect(r?.classification).toBe('internal_move');
    expect(r?.sourcePath).toBe('/t/utils.py');
  });

  it('does NOT launder an external paste that is later relocated', async () => {
    const index = await buildAndIndex({
      sessions: [
        {
          events: [
            { kind: 'doc.open', data: { path: '/t/scratch.py', content: '' } },
            // Arrives by paste — provenance kind 'paste', not 'typed'.
            pasteEvent('/t/scratch.py', BLOCK, 0),
            { kind: 'doc.open', data: { path: '/t/hw.py', content: '' } },
            // Relocated into the graded file.
            pasteEvent('/t/hw.py', BLOCK, 0),
          ],
        },
      ],
    });

    const results = classifyInternalMoves(index, cfg);
    expect(resultFor(index, results, 0)?.classification).not.toBe('internal_move');
    // The whole point: the relocation stays flagged.
    expect(resultFor(index, results, 1)?.classification).not.toBe('internal_move');
  });

  it('does NOT launder a cut-then-paste of externally pasted code', async () => {
    const index = await buildAndIndex({
      sessions: [
        {
          events: [
            { kind: 'doc.open', data: { path: '/t/hw.py', content: '' } },
            pasteEvent('/t/hw.py', BLOCK, 0),
            cutLines('/t/hw.py', 0, 5),
            pasteEvent('/t/hw.py', BLOCK, 0),
          ],
        },
      ],
    });

    const results = classifyInternalMoves(index, cfg);
    expect(resultFor(index, results, 1)?.classification).not.toBe('internal_move');
  });

  it('matches a block that was reindented on paste', async () => {
    const reindented = BLOCK.split('\n')
      .map((l) => (l.length > 0 ? `    ${l}` : l))
      .join('\n');
    const index = await buildAndIndex({
      sessions: [
        {
          events: [
            { kind: 'doc.open', data: { path: '/t/hw.py', content: '' } },
            typedInsert('/t/hw.py', BLOCK, 0),
            pasteEvent('/t/hw.py', reindented, 5),
          ],
        },
      ],
    });

    const r = resultFor(index, classifyInternalMoves(index, cfg), 0);
    expect(r?.classification).toBe('internal_move');
  });

  it('leaves a near-miss below minMatchRatio as external', async () => {
    const altered = BLOCK.replace('    total = 0', '    total = compute_seed(values, 17, True)');
    const index = await buildAndIndex({
      sessions: [
        {
          events: [
            { kind: 'doc.open', data: { path: '/t/hw.py', content: '' } },
            typedInsert('/t/hw.py', BLOCK, 0),
            pasteEvent('/t/hw.py', altered, 5),
          ],
        },
      ],
    });

    const r = resultFor(index, classifyInternalMoves(index, cfg), 0);
    expect(r?.classification).not.toBe('internal_move');
  });

  it('leaves a paste below minBlobChars as external', async () => {
    const tiny = 'x = 1\n';
    const index = await buildAndIndex({
      sessions: [
        {
          events: [
            { kind: 'doc.open', data: { path: '/t/hw.py', content: '' } },
            typedInsert('/t/hw.py', tiny, 0),
            pasteEvent('/t/hw.py', tiny, 1),
          ],
        },
      ],
    });

    const r = resultFor(index, classifyInternalMoves(index, cfg), 0);
    expect(r?.classification).not.toBe('internal_move');
  });

  it('treats preexisting starter code as the student’s own', async () => {
    const index = await buildAndIndex({
      sessions: [
        {
          events: [
            // Starter code handed to the student — provenance kind 'preexisting'.
            { kind: 'doc.open', data: { path: '/t/hw.py', content: BLOCK } },
            pasteEvent('/t/hw.py', BLOCK, 5),
          ],
        },
      ],
    });

    const r = resultFor(index, classifyInternalMoves(index, cfg), 0);
    expect(r?.classification).toBe('internal_move');
  });

  it('returns an empty map when disabled', async () => {
    const index = await buildAndIndex({
      sessions: [
        {
          events: [
            { kind: 'doc.open', data: { path: '/t/hw.py', content: '' } },
            typedInsert('/t/hw.py', BLOCK, 0),
            pasteEvent('/t/hw.py', BLOCK, 5),
          ],
        },
      ],
    });

    const disabled = mergeConfig({ internalMove: { ...cfg.internalMove, enabled: false } });
    expect(classifyInternalMoves(index, disabled).size).toBe(0);
  });

  it('is deterministic across repeated runs on the same index', async () => {
    const index = await buildAndIndex({
      sessions: [
        {
          events: [
            { kind: 'doc.open', data: { path: '/t/hw.py', content: '' } },
            typedInsert('/t/hw.py', BLOCK, 0),
            cutLines('/t/hw.py', 0, 5),
            pasteEvent('/t/hw.py', BLOCK, 0),
          ],
        },
      ],
    });

    const a = classifyInternalMoves(index, cfg);
    const b = classifyInternalMoves(index, cfg);
    expect([...a.entries()]).toEqual([...b.entries()]);
  });
});
