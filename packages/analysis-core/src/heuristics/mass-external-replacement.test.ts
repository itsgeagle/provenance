/**
 * Tests for the mass_external_replacement heuristic (Phase 16).
 */

import { describe, it, expect } from 'vitest';
import { massExternalReplacementHeuristic } from './mass-external-replacement.js';
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

// ---------------------------------------------------------------------------
// Positive: external_change where new content shares <20% lines with old
// ---------------------------------------------------------------------------

describe('mass_external_replacement — positive', () => {
  it('flags an external change that completely replaces file content', async () => {
    // Build: type some lines → save → external change → paste entirely new content → save
    // Pre-change content is set via doc.change; post-change content is set via paste after
    // external_change, then saved.
    const preContent =
      'original_line_1\noriginal_line_2\noriginal_line_3\noriginal_line_4\noriginal_line_5';
    // 5 lines; each char insert uses doc.change. For simplicity, use a paste as the pre-content.
    const postContent =
      'completely_new_1\ncompletely_new_2\ncompletely_new_3\ncompletely_new_4\ncompletely_new_5';
    // 0 shared lines → 0% overlap → flags

    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'doc.open',
              data: { path: '/hw/hw1.py', sha256: 'a'.repeat(64), line_count: 0 },
            },
            // Set pre-change content via paste
            {
              kind: 'paste',
              data: {
                path: '/hw/hw1.py',
                content: preContent,
                length: preContent.length,
                sha256: 'b'.repeat(64),
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              },
            },
            // Save pre-change
            { kind: 'doc.save', data: { path: '/hw/hw1.py', sha256: 'c'.repeat(64) } },
            // External change event (no content in payload)
            {
              kind: 'fs.external_change',
              data: {
                path: '/hw/hw1.py',
                old_hash: 'c'.repeat(64),
                new_hash: 'd'.repeat(64),
                diff_size: postContent.length - preContent.length,
              },
            },
            // Post-change content set via paste then save
            {
              kind: 'paste',
              data: {
                path: '/hw/hw1.py',
                content: postContent,
                length: postContent.length,
                sha256: 'e'.repeat(64),
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              },
            },
            { kind: 'doc.save', data: { path: '/hw/hw1.py', sha256: 'f'.repeat(64) } },
          ],
        },
      ],
    });

    const flags = massExternalReplacementHeuristic.run(index, bundle, cfg);
    expect(flags.length).toBeGreaterThanOrEqual(1);

    const flag = flags[0]!;
    expect(flag.heuristic).toBe('mass_external_replacement');
    expect(flag.severity).toBe('high');
    expect(flag.confidence).toBe(0.75);
    expect(flag.detail!['overlapRatio']).toBeLessThan(0.2);
  });
});

// ---------------------------------------------------------------------------
// Negative: external_change where >20% lines are shared
// ---------------------------------------------------------------------------

describe('mass_external_replacement — negative', () => {
  it('does not flag an external change that shares most lines', async () => {
    // Pre: 5 lines. Post: 4 of those same 5 lines + 1 new = 80% shared → no flag
    const sharedLines = 'line1\nline2\nline3\nline4';
    const preContent = sharedLines + '\nold_line5';
    const postContent = sharedLines + '\nnew_line5';
    // 4/5 shared = 80% > 20% threshold → should NOT flag

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
                content: preContent,
                length: preContent.length,
                sha256: 'b'.repeat(64),
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              },
            },
            { kind: 'doc.save', data: { path: '/hw/hw1.py', sha256: 'c'.repeat(64) } },
            {
              kind: 'fs.external_change',
              data: {
                path: '/hw/hw1.py',
                old_hash: 'c'.repeat(64),
                new_hash: 'd'.repeat(64),
                diff_size: 2,
              },
            },
            {
              kind: 'paste',
              data: {
                path: '/hw/hw1.py',
                content: postContent,
                length: postContent.length,
                sha256: 'e'.repeat(64),
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              },
            },
            { kind: 'doc.save', data: { path: '/hw/hw1.py', sha256: 'f'.repeat(64) } },
          ],
        },
      ],
    });

    const flags = massExternalReplacementHeuristic.run(index, bundle, cfg);
    expect(flags.filter((f) => f.heuristic === 'mass_external_replacement')).toHaveLength(0);
  });

  it('produces no flags when there are no fs.external_change events', async () => {
    const { index, bundle } = await buildAndIndex({ sessions: [{ eventCount: 3 }] });
    const flags = massExternalReplacementHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(0);
  });

  it('skips an external_change event when there is no subsequent save (cannot determine post-change content)', async () => {
    // external_change at the very end with no doc.save after it
    const preContent = 'line1\nline2\nline3';

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
                content: preContent,
                length: preContent.length,
                sha256: 'b'.repeat(64),
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              },
            },
            { kind: 'doc.save', data: { path: '/hw/hw1.py', sha256: 'c'.repeat(64) } },
            // external_change with no following save → skip
            {
              kind: 'fs.external_change',
              data: {
                path: '/hw/hw1.py',
                old_hash: 'c'.repeat(64),
                new_hash: 'd'.repeat(64),
                diff_size: 50,
              },
            },
            // No doc.save after external_change
          ],
        },
      ],
    });

    const flags = massExternalReplacementHeuristic.run(index, bundle, cfg);
    expect(flags.filter((f) => f.heuristic === 'mass_external_replacement')).toHaveLength(0);
  });

  it('skips an external_change when pre-change content is empty (cannot compare)', async () => {
    // First event is the external_change → no pre-content available
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'doc.open',
              data: { path: '/hw/hw1.py', sha256: 'a'.repeat(64), line_count: 0 },
            },
            // external_change immediately (no prior content to compare)
            {
              kind: 'fs.external_change',
              data: {
                path: '/hw/hw1.py',
                old_hash: 'a'.repeat(64),
                new_hash: 'b'.repeat(64),
                diff_size: 100,
              },
            },
            {
              kind: 'paste',
              data: {
                path: '/hw/hw1.py',
                content: 'new content here\n',
                length: 17,
                sha256: 'c'.repeat(64),
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              },
            },
            { kind: 'doc.save', data: { path: '/hw/hw1.py', sha256: 'd'.repeat(64) } },
          ],
        },
      ],
    });

    const flags = massExternalReplacementHeuristic.run(index, bundle, cfg);
    expect(flags.filter((f) => f.heuristic === 'mass_external_replacement')).toHaveLength(0);
  });

  it('does not flag when external_change is whitespace-only but user types afterward (immediate post-change content differs from next-save content)', async () => {
    // Scenario: formatter does whitespace-only external change → student types 50 chars
    // → saves. Using nextSaveGi+1 would inflate the diff. Using e.globalIdx+1 (immediate
    // post-change) avoids this false positive.
    //
    // Pre-change: "code\nwith\nindent"  (3 lines)
    // External change: reformats to "code\n  with\nindent" (same 3 lines, whitespace adjusted)
    // User typing after external_change: adds 50 chars of new code → save
    // At immediate post-change (e.globalIdx+1): content is the reformatted version (80% shared)
    // At next save: content includes the 50 new chars (lower shared ratio)
    //
    // We want NO flag since the external change was whitespace-only (80% shared).

    const preContent = 'code\nwith\nindent';
    const userTypingContent = 'code\n  with\n  indent\n' + 'x'.repeat(50);

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
                content: preContent,
                length: preContent.length,
                sha256: 'b'.repeat(64),
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              },
            },
            { kind: 'doc.save', data: { path: '/hw/hw1.py', sha256: 'c'.repeat(64) } },
            // External change (e.g., formatter): whitespace-only, no semantic change
            {
              kind: 'fs.external_change',
              data: {
                path: '/hw/hw1.py',
                old_hash: 'c'.repeat(64),
                new_hash: 'd'.repeat(64),
                diff_size: 4, // small, just whitespace
              },
            },
            // Immediately after external change: reformatted content
            // (in a real scenario this would be captured by doc.change or paste events,
            // but we simulate it by relying on reconstruction)
            // Then user types 50 chars
            {
              kind: 'paste',
              data: {
                path: '/hw/hw1.py',
                content: userTypingContent,
                length: userTypingContent.length,
                sha256: 'e'.repeat(64),
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 0, character: preContent.length },
                },
              },
            },
            { kind: 'doc.save', data: { path: '/hw/hw1.py', sha256: 'f'.repeat(64) } },
          ],
        },
      ],
    });

    const flags = massExternalReplacementHeuristic.run(index, bundle, cfg);
    // Should NOT flag because at immediate post-change (e.globalIdx+1), the content
    // is the whitespace-reformatted version with 3 shared lines / 3 max = 100% shared.
    expect(flags.filter((f) => f.heuristic === 'mass_external_replacement')).toHaveLength(0);
  });
});
