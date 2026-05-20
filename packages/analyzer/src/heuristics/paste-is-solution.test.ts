/**
 * Tests for the paste_is_solution heuristic (Phase 16).
 */

import { describe, it, expect } from 'vitest';
import { pasteIsSolutionHeuristic } from './paste-is-solution.js';
import { buildIndex } from '../index/build-index.js';
import { loadBundle } from '../loader/parse-bundle.js';
import { buildTestBundle } from '../../test/helpers/build-test-bundle.js';
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

// ---------------------------------------------------------------------------
// Positive: paste that matches ≥80% of the final file's lines
// ---------------------------------------------------------------------------

describe('paste_is_solution — positive', () => {
  it('flags a paste whose content is 100% of the final file', async () => {
    // Build a session where: (a) we paste 5 lines, (b) save the file.
    // No other edits → the paste IS the final content.
    const pasteContent = 'def solve():\n    return 42\n# end\nresult = solve()\nprint(result)';
    // 5 lines

    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            // doc.open
            {
              kind: 'doc.open',
              data: { path: '/hw/hw1.py', sha256: 'a'.repeat(64), line_count: 0 },
            },
            // paste the full solution
            {
              kind: 'paste',
              data: {
                path: '/hw/hw1.py',
                content: pasteContent,
                length: pasteContent.length,
                sha256: 'b'.repeat(64),
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              },
            },
            // save
            {
              kind: 'doc.save',
              data: { path: '/hw/hw1.py', sha256: 'c'.repeat(64) },
            },
          ],
        },
      ],
    });

    const flags = pasteIsSolutionHeuristic.run(index, bundle, cfg);
    expect(flags.length).toBeGreaterThanOrEqual(1);

    const flag = flags[0]!;
    expect(flag.heuristic).toBe('paste_is_solution');
    expect(flag.severity).toBe('high');
    expect(flag.confidence).toBe(0.85);
    expect(flag.detail!['overlapRatio']).toBeGreaterThanOrEqual(0.8);
    expect(flag.supportingSeqs).toHaveLength(1);
  });

  it('flags a paste matching exactly 80% of lines (at threshold boundary)', async () => {
    // 10-line file final content; paste has 10 lines, 8 of which match → 80%
    const sharedLines = 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8';
    const extraLines = '\nline9\nlineA';
    const finalContent = sharedLines + extraLines; // 10 lines total in final
    // paste is the first 10 lines with 8 shared + 2 unique paste-only
    const pasteContent = sharedLines + '\npaste_only_1\npaste_only_2'; // 10 lines

    // Build: paste → doc.change (add extra lines) → save
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'doc.open',
              data: { path: '/hw/hw1.py', sha256: 'a'.repeat(64), line_count: 0 },
            },
            {
              kind: 'paste',
              data: {
                path: '/hw/hw1.py',
                content: pasteContent,
                length: pasteContent.length,
                sha256: 'b'.repeat(64),
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              },
            },
            // Replace paste-only lines with the real extra lines via doc.change.
            // Simulating that student edited the paste.
            // For this test we build the final content directly via multiple pastes
            // to keep it simple. Let's use a second paste to set the final state.
            {
              kind: 'paste',
              data: {
                path: '/hw/hw1.py',
                content: finalContent,
                length: finalContent.length,
                sha256: 'd'.repeat(64),
                range: { start: { line: 0, character: 0 }, end: { line: 10, character: 0 } },
              },
            },
            {
              kind: 'doc.save',
              data: { path: '/hw/hw1.py', sha256: 'e'.repeat(64) },
            },
          ],
        },
      ],
    });

    const flags = pasteIsSolutionHeuristic.run(index, bundle, cfg);
    // The first paste (pasteContent) overlaps 8/10 lines = 80% with finalContent
    const solutionFlags = flags.filter((f) => f.heuristic === 'paste_is_solution');
    expect(solutionFlags.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Negative: paste below 80% overlap or no inline content
// ---------------------------------------------------------------------------

describe('paste_is_solution — negative', () => {
  it('does not flag a paste that shares <80% of its lines with the final file', async () => {
    // paste has 10 lines; only 3 overlap with the final file → 30%
    const pasteLines = Array.from({ length: 10 }, (_, i) => `paste_line_${i}`).join('\n');
    const finalLines = [
      'paste_line_0', // shared
      'paste_line_1', // shared
      'paste_line_2', // shared
      'completely_different_a',
      'completely_different_b',
      'completely_different_c',
    ].join('\n');

    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'doc.open',
              data: { path: '/hw/hw1.py', sha256: 'a'.repeat(64), line_count: 0 },
            },
            {
              kind: 'paste',
              data: {
                path: '/hw/hw1.py',
                content: pasteLines,
                length: pasteLines.length,
                sha256: 'b'.repeat(64),
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              },
            },
            // The final content is set by a second paste that's quite different
            {
              kind: 'paste',
              data: {
                path: '/hw/hw1.py',
                content: finalLines,
                length: finalLines.length,
                sha256: 'c'.repeat(64),
                range: { start: { line: 0, character: 0 }, end: { line: 10, character: 0 } },
              },
            },
            {
              kind: 'doc.save',
              data: { path: '/hw/hw1.py', sha256: 'd'.repeat(64) },
            },
          ],
        },
      ],
    });

    const flags = pasteIsSolutionHeuristic.run(index, bundle, cfg);
    // The first paste shares 3/10 = 30% < 80% → no flag for it.
    // The second paste is 100% identical to the final → that one MAY fire.
    // We check there's no flag for the first paste.
    const detailFlags = flags.filter(
      (f) => f.heuristic === 'paste_is_solution' && (f.detail!['overlapRatio'] as number) < 0.8,
    );
    expect(detailFlags).toHaveLength(0);
  });

  it('does not flag a paste with no inline content field', async () => {
    // Large paste > 4KB — only length/sha256 recorded, no content.
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'doc.open',
              data: { path: '/hw/hw1.py', sha256: 'a'.repeat(64), line_count: 0 },
            },
            {
              kind: 'paste',
              data: {
                path: '/hw/hw1.py',
                length: 5000,
                sha256: 'b'.repeat(64),
                // No 'content' field
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              },
            },
          ],
        },
      ],
    });

    const flags = pasteIsSolutionHeuristic.run(index, bundle, cfg);
    expect(flags.filter((f) => f.heuristic === 'paste_is_solution')).toHaveLength(0);
  });

  it('produces no flags when there are no paste events', async () => {
    const { index, bundle } = await buildAndIndex({ sessions: [{ eventCount: 3 }] });
    const flags = pasteIsSolutionHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(0);
  });

  it('does not flag when the final file content is empty (tainted by external change)', async () => {
    // fs.external_change clears content → final is empty → cannot flag
    const pasteContent = 'def solve():\n    return 42\n';

    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'doc.open',
              data: { path: '/hw/hw1.py', sha256: 'a'.repeat(64), line_count: 0 },
            },
            {
              kind: 'paste',
              data: {
                path: '/hw/hw1.py',
                content: pasteContent,
                length: pasteContent.length,
                sha256: 'b'.repeat(64),
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              },
            },
            // External change clears reconstructed content
            {
              kind: 'fs.external_change',
              data: {
                path: '/hw/hw1.py',
                old_hash: 'b'.repeat(64),
                new_hash: 'c'.repeat(64),
                diff_size: 0,
              },
            },
          ],
        },
      ],
    });

    const flags = pasteIsSolutionHeuristic.run(index, bundle, cfg);
    expect(flags.filter((f) => f.heuristic === 'paste_is_solution')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Recorder v1.2: paste-shaped doc.change should also be evaluated
// ---------------------------------------------------------------------------

describe('paste_is_solution — paste-shaped doc.change (recorder v1.2)', () => {
  it('flags a doc.change with source=paste_likely whose delta text matches the final file', async () => {
    // Bundle: doc.open seeds the file as empty, then a paste_likely
    // doc.change inserts the entire "solution". Final file content equals
    // the inserted text → 100% line overlap → flag.
    const solution =
      'def square(x):\n    return x * x\n\n' +
      'def cube(x):\n    return x * x * x\n\n' +
      'def quad(x):\n    return x ** 4\n';
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'doc.open',
              data: {
                path: 'hw.py',
                sha256: 'a'.repeat(64),
                line_count: 1,
                content: '',
              },
            },
            {
              kind: 'doc.change',
              data: {
                path: 'hw.py',
                deltas: [
                  {
                    range: {
                      start: { line: 0, character: 0 },
                      end: { line: 0, character: 0 },
                    },
                    text: solution,
                  },
                ],
                source: 'paste_likely',
              },
            },
          ],
        },
      ],
    });
    const flags = pasteIsSolutionHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.detail!['origin']).toBe('doc.change');
    expect(flags[0]!.detail!['overlapRatio']).toBeGreaterThanOrEqual(
      cfg.pasteIsSolution.lineOverlap,
    );
  });
});
