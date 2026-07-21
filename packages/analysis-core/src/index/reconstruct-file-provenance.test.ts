/**
 * Tests for reconstruct-file-provenance.ts (Phase 12).
 *
 * Exit gate (per task spec): final `content` + `hashBySaveSeq` must match
 * v1's `reconstructFile` byte-for-byte on every synthetic stream we test.
 */

import { describe, it, expect } from 'vitest';
import {
  reconstructFileWithProvenance,
  spliceWithProvenance,
} from './reconstruct-file-provenance.js';
import { reconstructFile } from './reconstruct-file.js';
import { buildIndex } from './build-index.js';
import { loadBundle } from '../loader/parse-bundle.js';
import type { Bundle } from '../loader/types.js';
import { buildTestBundle } from '../test-support/build-test-bundle.js';
import { sha256Hex } from '@provenance/log-core';

async function loadBundleFrom(zipBuffer: ArrayBuffer): Promise<Bundle> {
  const loaded = await loadBundle(new Blob([zipBuffer]), 'test.zip');
  if (!loaded.ok) throw new Error('Expected successful bundle load');
  return loaded.value;
}

// ---------------------------------------------------------------------------
// spliceWithProvenance — unit edge cases
// ---------------------------------------------------------------------------

describe('spliceWithProvenance', () => {
  it('inserts into an empty buffer', () => {
    const { content, provenance } = spliceWithProvenance('', [], 0, 0, 'hi', 7);
    expect(content).toBe('hi');
    expect(provenance).toEqual([7, 7]);
  });

  it('inserts into the middle, attributing new chars to globalIdx', () => {
    const { content, provenance } = spliceWithProvenance('abcde', [1, 1, 1, 1, 1], 2, 2, 'XX', 9);
    expect(content).toBe('abXXcde');
    expect(provenance).toEqual([1, 1, 9, 9, 1, 1, 1]);
  });

  it('replaces a range (delete + insert)', () => {
    const { content, provenance } = spliceWithProvenance('abcde', [1, 2, 3, 4, 5], 1, 3, 'Z', 7);
    expect(content).toBe('aZde');
    expect(provenance).toEqual([1, 7, 4, 5]);
  });

  it('deletes a range (empty replacement)', () => {
    const { content, provenance } = spliceWithProvenance('abcde', [1, 2, 3, 4, 5], 1, 3, '', 7);
    expect(content).toBe('ade');
    expect(provenance).toEqual([1, 4, 5]);
  });

  it('replacement longer than range', () => {
    const { content, provenance } = spliceWithProvenance('abc', [1, 2, 3], 0, 1, 'XYZ', 9);
    expect(content).toBe('XYZbc');
    expect(provenance).toEqual([9, 9, 9, 2, 3]);
  });

  it('replacement covers whole string', () => {
    const { content, provenance } = spliceWithProvenance('abc', [1, 2, 3], 0, 3, 'NEW', 9);
    expect(content).toBe('NEW');
    expect(provenance).toEqual([9, 9, 9]);
  });

  it('append at end (start === end === length)', () => {
    const { content, provenance } = spliceWithProvenance('abc', [1, 2, 3], 3, 3, 'Z', 9);
    expect(content).toBe('abcZ');
    expect(provenance).toEqual([1, 2, 3, 9]);
  });
});

// ---------------------------------------------------------------------------
// reconstructFileWithProvenance — basic behavior
// ---------------------------------------------------------------------------

describe('reconstructFileWithProvenance — basic', () => {
  it('reconstructs content and per-char provenance after sequential inserts', async () => {
    // buildTestBundle inserts 'x1', 'x2', 'x3' at line 0 char 0 (prepends).
    // After 3 events the content is 'x3x2x1'.
    // Chars 'x3' should be attributed to the third event, 'x2' to the second,
    // 'x1' to the first.
    const { zipBuffer } = await buildTestBundle({ sessions: [{ eventCount: 3 }] });
    const bundle = await loadBundleFrom(zipBuffer);
    const index = buildIndex(bundle);

    const state = reconstructFileWithProvenance(index, '/test/file.py');
    expect(state.content).toBe('x3x2x1');
    expect(state.provenance.length).toBe(state.content.length);

    // Find the three doc.change globalIdx values, in order.
    const changes = (index.byKind.get('doc.change') ?? []).slice().sort((a, b) => a.seq - b.seq);
    expect(changes.length).toBe(3);
    const [g1, g2, g3] = [changes[0]!.globalIdx, changes[1]!.globalIdx, changes[2]!.globalIdx];

    // 'x3' (most recently written) → g3; 'x2' → g2; 'x1' → g1.
    expect(Array.from(state.provenance)).toEqual([g3, g3, g2, g2, g1, g1]);

    // kindByGlobalIdx records each as 'typed'.
    expect(state.kindByGlobalIdx.get(g1)).toBe('typed');
    expect(state.kindByGlobalIdx.get(g2)).toBe('typed');
    expect(state.kindByGlobalIdx.get(g3)).toBe('typed');
  });

  it('returns empty state for an unknown file path', async () => {
    const { zipBuffer } = await buildTestBundle({ sessions: [{ eventCount: 2 }] });
    const bundle = await loadBundleFrom(zipBuffer);
    const index = buildIndex(bundle);
    const state = reconstructFileWithProvenance(index, '/nonexistent.py');
    expect(state.content).toBe('');
    expect(state.provenance.length).toBe(0);
    expect(state.kindByGlobalIdx.size).toBe(0);
    expect(state.hashBySaveSeq.size).toBe(0);
  });

  it('returned provenance is a Uint32Array', async () => {
    const { zipBuffer } = await buildTestBundle({ sessions: [{ eventCount: 1 }] });
    const bundle = await loadBundleFrom(zipBuffer);
    const index = buildIndex(bundle);
    const state = reconstructFileWithProvenance(index, '/test/file.py');
    expect(state.provenance).toBeInstanceOf(Uint32Array);
  });

  it('records doc.save sha256 in hashBySaveSeq', async () => {
    const { zipBuffer } = await buildTestBundle({
      sessions: [{ eventCount: 2, appendDocSave: true }],
    });
    const bundle = await loadBundleFrom(zipBuffer);
    const index = buildIndex(bundle);
    const state = reconstructFileWithProvenance(index, '/test/file.py');
    expect(state.hashBySaveSeq.size).toBe(1);
    const recorded = [...state.hashBySaveSeq.values()][0]!;
    expect(recorded).toBe(sha256Hex(state.content));
  });
});

// ---------------------------------------------------------------------------
// upToGlobalIdx cutoff
// ---------------------------------------------------------------------------

describe('reconstructFileWithProvenance — upToGlobalIdx', () => {
  it('stops before processing the event at upToGlobalIdx', async () => {
    const { zipBuffer } = await buildTestBundle({ sessions: [{ eventCount: 3 }] });
    const bundle = await loadBundleFrom(zipBuffer);
    const index = buildIndex(bundle);

    const changes = (index.byKind.get('doc.change') ?? []).slice().sort((a, b) => a.seq - b.seq);
    const third = changes[2]!;
    const state = reconstructFileWithProvenance(index, '/test/file.py', third.globalIdx);
    expect(state.content).toBe('x2x1');
    expect(state.provenance.length).toBe(state.content.length);
    // Third event must not appear in kindByGlobalIdx.
    expect(state.kindByGlobalIdx.has(third.globalIdx)).toBe(false);
  });

  it('upToGlobalIdx === 0 yields empty content', async () => {
    const { zipBuffer } = await buildTestBundle({ sessions: [{ eventCount: 3 }] });
    const bundle = await loadBundleFrom(zipBuffer);
    const index = buildIndex(bundle);
    const state = reconstructFileWithProvenance(index, '/test/file.py', 0);
    expect(state.content).toBe('');
    expect(state.provenance.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Paste handling
// ---------------------------------------------------------------------------

describe('reconstructFileWithProvenance — paste', () => {
  it('inline paste: only the pasted range is attributed to the paste event', async () => {
    const { zipBuffer } = await buildTestBundle({
      sessions: [
        {
          events: [
            {
              kind: 'doc.change',
              data: {
                path: '/src/app.py',
                deltas: [
                  {
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                    text: 'ABC',
                  },
                ],
                source: 'typed',
              },
            },
            {
              kind: 'paste',
              data: {
                path: '/src/app.py',
                range: { start: { line: 0, character: 3 }, end: { line: 0, character: 3 } },
                length: 5,
                sha256: 'inline',
                content: 'PASTE',
              },
            },
          ],
        },
      ],
    });
    const bundle = await loadBundleFrom(zipBuffer);
    const index = buildIndex(bundle);
    const state = reconstructFileWithProvenance(index, '/src/app.py');

    expect(state.content).toBe('ABCPASTE');

    const change = (index.byKind.get('doc.change') ?? [])[0]!;
    const paste = (index.byKind.get('paste') ?? [])[0]!;

    // ABC → change.globalIdx; PASTE → paste.globalIdx.
    expect(Array.from(state.provenance)).toEqual([
      change.globalIdx,
      change.globalIdx,
      change.globalIdx,
      paste.globalIdx,
      paste.globalIdx,
      paste.globalIdx,
      paste.globalIdx,
      paste.globalIdx,
    ]);
    expect(state.kindByGlobalIdx.get(change.globalIdx)).toBe('typed');
    expect(state.kindByGlobalIdx.get(paste.globalIdx)).toBe('paste');
  });

  it('large paste (no inline content): content + provenance preserved, not attributed', async () => {
    const { zipBuffer } = await buildTestBundle({
      sessions: [
        {
          events: [
            {
              kind: 'doc.change',
              data: {
                path: '/src/big.py',
                deltas: [
                  {
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                    text: 'before',
                  },
                ],
                source: 'typed',
              },
            },
            {
              kind: 'paste',
              data: {
                path: '/src/big.py',
                range: { start: { line: 0, character: 6 }, end: { line: 0, character: 6 } },
                length: 9999,
                sha256: 'deadbeef',
                content_head: 'head',
                content_tail: 'tail',
              },
            },
          ],
        },
      ],
    });
    const bundle = await loadBundleFrom(zipBuffer);
    const index = buildIndex(bundle);
    const state = reconstructFileWithProvenance(index, '/src/big.py');
    // POLICY (changed 2026-07): the pasted text is unknown, but the surrounding
    // content is not — keep it. Matches the base replay; '' is never correct.
    expect(state.content).toBe('before');
    expect(state.provenance.length).toBe('before'.length);
  });
});

// ---------------------------------------------------------------------------
// fs.external_change handling
// ---------------------------------------------------------------------------

describe('reconstructFileWithProvenance — fs.external_change', () => {
  it('preserves content + provenance on a contentless modify, tagging the event', async () => {
    const { zipBuffer } = await buildTestBundle({
      sessions: [
        {
          events: [
            {
              kind: 'doc.change',
              data: {
                path: '/src/x.py',
                deltas: [
                  {
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                    text: 'original',
                  },
                ],
                source: 'typed',
              },
            },
            {
              kind: 'fs.external_change',
              data: {
                path: '/src/x.py',
                old_hash: 'aaa',
                new_hash: 'bbb',
                diff_size: 10,
              },
            },
          ],
        },
      ],
    });
    const bundle = await loadBundleFrom(zipBuffer);
    const index = buildIndex(bundle);
    const state = reconstructFileWithProvenance(index, '/src/x.py');

    // POLICY (changed 2026-07): an external write we cannot see (>4 KB, so no
    // inline new_content) no longer zeroes content or provenance. '' is never
    // the true content, whereas the last known content frequently still is, and
    // callers gate on `tainted` / the kindByGlobalIdx sentinel. Kept in lockstep
    // with reconstruct-file.ts (reconstruct-line-index.fuzz.test.ts pins this).
    expect(state.content).toBe('original');
    expect(state.provenance.length).toBe('original'.length);

    const ext = (index.byKind.get('fs.external_change') ?? [])[0]!;
    expect(state.kindByGlobalIdx.get(ext.globalIdx)).toBe('external_change');
  });

  it('operation:delete clears content + provenance even when new_content would otherwise be inlined', async () => {
    const original = 'def foo(): pass\n';
    const { zipBuffer } = await buildTestBundle({
      sessions: [
        {
          events: [
            {
              kind: 'doc.change',
              data: {
                path: '/src/x.py',
                deltas: [
                  {
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                    text: original,
                  },
                ],
                source: 'typed',
              },
            },
            {
              kind: 'fs.external_change',
              data: {
                path: '/src/x.py',
                operation: 'delete',
                old_hash: 'aaa',
                new_hash: '',
                diff_size: original.length,
              },
            },
          ],
        },
      ],
    });
    const bundle = await loadBundleFrom(zipBuffer);
    const index = buildIndex(bundle);
    const state = reconstructFileWithProvenance(index, '/src/x.py');

    expect(state.content).toBe('');
    expect(state.provenance.length).toBe(0);

    const ext = (index.byKind.get('fs.external_change') ?? [])[0]!;
    expect(state.kindByGlobalIdx.get(ext.globalIdx)).toBe('external_change');
  });

  it('operation:create attributes every char to the event (pre-state was empty)', async () => {
    const newContent = 'def fresh(): return 1\n';
    const { zipBuffer } = await buildTestBundle({
      sessions: [
        {
          events: [
            {
              kind: 'fs.external_change',
              data: {
                path: '/src/x.py',
                operation: 'create',
                old_hash: '',
                new_hash: 'bbb',
                diff_size: newContent.length,
                new_content: newContent,
                new_content_size: newContent.length,
              },
            },
          ],
        },
      ],
    });
    const bundle = await loadBundleFrom(zipBuffer);
    const index = buildIndex(bundle);
    const state = reconstructFileWithProvenance(index, '/src/x.py');

    expect(state.content).toBe(newContent);
    expect(state.provenance.length).toBe(newContent.length);

    const ext = (index.byKind.get('fs.external_change') ?? [])[0]!;
    for (let i = 0; i < state.provenance.length; i++) {
      expect(state.provenance[i]).toBe(ext.globalIdx);
    }
  });

  it('granular line-diff: only changed lines attributed to the event, unchanged lines keep prior provenance', async () => {
    // Start: 4 lines typed. External tool replaces line 2 only.
    // Expected: lines 1, 3, 4 keep their original 'typed' provenance,
    // line 2's chars are attributed to the fs.external_change event.
    const original = 'line one\nline two\nline three\nline four\n';
    const modified = 'line one\nLINE TWO (rewritten)\nline three\nline four\n';
    const { zipBuffer } = await buildTestBundle({
      sessions: [
        {
          events: [
            {
              kind: 'doc.change',
              data: {
                path: '/src/x.py',
                deltas: [
                  {
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                    text: original,
                  },
                ],
                source: 'typed',
              },
            },
            {
              kind: 'fs.external_change',
              data: {
                path: '/src/x.py',
                old_hash: 'aaa',
                new_hash: 'bbb',
                diff_size: modified.length - original.length,
                new_content: modified,
                new_content_size: modified.length,
              },
            },
          ],
        },
      ],
    });
    const bundle = await loadBundleFrom(zipBuffer);
    const index = buildIndex(bundle);
    const state = reconstructFileWithProvenance(index, '/src/x.py');

    expect(state.content).toBe(modified);
    expect(state.provenance.length).toBe(modified.length);

    const typedEvent = (index.byKind.get('doc.change') ?? [])[0]!;
    const extEvent = (index.byKind.get('fs.external_change') ?? [])[0]!;

    // Lines 1, 3, 4 should keep the typed-event globalIdx.
    // Line 2 ('LINE TWO (rewritten)\n') should be attributed to the external_change event.
    // Find the byte range of line 2 in `modified`:
    const line2Start = 'line one\n'.length;
    const line2End = line2Start + 'LINE TWO (rewritten)\n'.length;

    // Line 1 chars → typed
    for (let i = 0; i < line2Start; i++) {
      expect(state.provenance[i]).toBe(typedEvent.globalIdx);
    }
    // Line 2 chars → external_change
    for (let i = line2Start; i < line2End; i++) {
      expect(state.provenance[i]).toBe(extEvent.globalIdx);
    }
    // Lines 3+4 chars → typed
    for (let i = line2End; i < modified.length; i++) {
      expect(state.provenance[i]).toBe(typedEvent.globalIdx);
    }
  });

  it('whole-file replacement: every char attributed to the event (back-compat with v1.3 initial behavior)', async () => {
    const after = 'def foo(): return 42\n';
    const { zipBuffer } = await buildTestBundle({
      sessions: [
        {
          events: [
            {
              kind: 'doc.change',
              data: {
                path: '/src/x.py',
                deltas: [
                  {
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                    text: 'original',
                  },
                ],
                source: 'typed',
              },
            },
            {
              kind: 'fs.external_change',
              data: {
                path: '/src/x.py',
                old_hash: 'aaa',
                new_hash: 'bbb',
                diff_size: after.length,
                new_content: after,
                new_content_size: after.length,
              },
            },
          ],
        },
      ],
    });
    const bundle = await loadBundleFrom(zipBuffer);
    const index = buildIndex(bundle);
    const state = reconstructFileWithProvenance(index, '/src/x.py');

    expect(state.content).toBe(after);
    expect(state.provenance.length).toBe(after.length);

    const ext = (index.byKind.get('fs.external_change') ?? [])[0]!;
    expect(state.kindByGlobalIdx.get(ext.globalIdx)).toBe('external_change');
    // Every character in the reseeded content references the external_change event.
    for (let i = 0; i < state.provenance.length; i++) {
      expect(state.provenance[i]).toBe(ext.globalIdx);
    }
  });
});

// ---------------------------------------------------------------------------
// Multi-line + multi-delta splice (the provenance has to line up with chars
// after deltas applied in reverse-document order — see v1's contract note).
// ---------------------------------------------------------------------------

describe('reconstructFileWithProvenance — multi-delta event', () => {
  it('attributes all inserted chars from a single multi-delta event to that event', async () => {
    // Single doc.change with two deltas (reverse document order):
    //   start with 'abcdef', delete [4,5] ('e'), delete [0,2] ('ab') → 'cdf'.
    // Then a second doc.change inserts 'XY' at [0,0] → 'XYcdf'.
    const { zipBuffer } = await buildTestBundle({
      sessions: [
        {
          events: [
            {
              kind: 'doc.change',
              data: {
                path: '/src/m.py',
                deltas: [
                  {
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                    text: 'abcdef',
                  },
                ],
                source: 'typed',
              },
            },
            {
              kind: 'doc.change',
              data: {
                path: '/src/m.py',
                deltas: [
                  {
                    range: { start: { line: 0, character: 4 }, end: { line: 0, character: 5 } },
                    text: '',
                  },
                  {
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } },
                    text: '',
                  },
                ],
                source: 'typed',
              },
            },
            {
              kind: 'doc.change',
              data: {
                path: '/src/m.py',
                deltas: [
                  {
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                    text: 'XY',
                  },
                ],
                source: 'typed',
              },
            },
          ],
        },
      ],
    });
    const bundle = await loadBundleFrom(zipBuffer);
    const index = buildIndex(bundle);
    const state = reconstructFileWithProvenance(index, '/src/m.py');

    expect(state.content).toBe('XYcdf');

    const changes = (index.byKind.get('doc.change') ?? []).slice().sort((a, b) => a.seq - b.seq);
    const [g1, g3] = [changes[0]!.globalIdx, changes[2]!.globalIdx];
    // 'XY' from event 3, 'cdf' from event 1 (event 2 was a delete-only).
    expect(Array.from(state.provenance)).toEqual([g3, g3, g1, g1, g1]);
  });
});

// ---------------------------------------------------------------------------
// Exit gate: v1 parity on `content` + `hashBySaveSeq`
// ---------------------------------------------------------------------------

describe('reconstructFileWithProvenance — v1 parity (exit gate)', () => {
  /**
   * Run both reconstructFile and reconstructFileWithProvenance on the same
   * synthetic stream and assert byte-identical `content` + identical
   * `hashBySaveSeq`. This is the lockstep invariant that lets us treat the
   * two implementations as equivalent for content/hash purposes despite
   * each being maintained as separate code.
   *
   * NOTE: parity does NOT hold once v1 taints (v1 resets content to '' and
   * stops applying deltas; v2 also clears but the "stops applying" semantics
   * differ — v1 has a sticky tainted flag, v2 does not). For taint streams
   * the parity check is restricted to clean prefixes via upToGlobalIdx.
   */
  it('matches v1 on a 3-insert clean stream (final state)', async () => {
    const { zipBuffer } = await buildTestBundle({
      sessions: [{ eventCount: 3, appendDocSave: true }],
    });
    const bundle = await loadBundleFrom(zipBuffer);
    const index = buildIndex(bundle);

    const v1 = reconstructFile(index, '/test/file.py');
    const v2 = reconstructFileWithProvenance(index, '/test/file.py');

    expect(v2.content).toBe(v1.content);
    expect([...v2.hashBySaveSeq.entries()]).toEqual([...v1.hashBySaveSeq.entries()]);
  });

  it('matches v1 at every doc.save checkpoint in a clean stream', async () => {
    const { zipBuffer } = await buildTestBundle({
      sessions: [{ eventCount: 5, appendDocSave: true }],
    });
    const bundle = await loadBundleFrom(zipBuffer);
    const index = buildIndex(bundle);

    // Walk every event globalIdx and assert both reconstructors agree.
    const fileEvents = index.byFile.get('/test/file.py') ?? [];
    for (const e of fileEvents) {
      const v1 = reconstructFile(index, '/test/file.py', e.globalIdx + 1);
      const v2 = reconstructFileWithProvenance(index, '/test/file.py', e.globalIdx + 1);
      expect(v2.content).toBe(v1.content);
      expect([...v2.hashBySaveSeq.entries()]).toEqual([...v1.hashBySaveSeq.entries()]);
    }
  });

  it('matches v1 across a stream with inline paste + multi-delta change', async () => {
    const { zipBuffer } = await buildTestBundle({
      sessions: [
        {
          events: [
            {
              kind: 'doc.change',
              data: {
                path: '/src/mix.py',
                deltas: [
                  {
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                    text: 'abcdef',
                  },
                ],
                source: 'typed',
              },
            },
            {
              kind: 'doc.change',
              data: {
                path: '/src/mix.py',
                deltas: [
                  {
                    range: { start: { line: 0, character: 4 }, end: { line: 0, character: 5 } },
                    text: '',
                  },
                  {
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } },
                    text: '',
                  },
                ],
                source: 'typed',
              },
            },
            {
              kind: 'paste',
              data: {
                path: '/src/mix.py',
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                length: 4,
                sha256: 'inline',
                content: 'PRE\n',
              },
            },
            {
              kind: 'doc.save',
              data: { path: '/src/mix.py', sha256: 'fake-hash-here' },
            },
          ],
        },
      ],
    });
    const bundle = await loadBundleFrom(zipBuffer);
    const index = buildIndex(bundle);

    const v1 = reconstructFile(index, '/src/mix.py');
    const v2 = reconstructFileWithProvenance(index, '/src/mix.py');
    expect(v2.content).toBe(v1.content);
    expect([...v2.hashBySaveSeq.entries()]).toEqual([...v1.hashBySaveSeq.entries()]);
  });
});

// ---------------------------------------------------------------------------
// Perf smoke (not a hard budget; informational)
// ---------------------------------------------------------------------------

describe('reconstructFileWithProvenance — perf smoke', () => {
  it('processes a synthetic 1000-delta stream comfortably under 1s', async () => {
    const events = [];
    for (let i = 0; i < 1000; i++) {
      events.push({
        kind: 'doc.change' as const,
        data: {
          path: '/p.py',
          deltas: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              text: 'x',
            },
          ],
          source: 'typed' as const,
        },
      });
    }
    const { zipBuffer } = await buildTestBundle({ sessions: [{ events }] });
    const bundle = await loadBundleFrom(zipBuffer);
    const index = buildIndex(bundle);

    const start = performance.now();
    const state = reconstructFileWithProvenance(index, '/p.py');
    const elapsed = performance.now() - start;

    expect(state.content.length).toBe(1000);
    expect(state.provenance.length).toBe(1000);
    expect(elapsed).toBeLessThan(1000);
  });
});

// ---------------------------------------------------------------------------
// reconstructFileWithProvenance — recorder v1.1 doc.open content seeding
// ---------------------------------------------------------------------------

describe('reconstructFileWithProvenance — doc.open content seeding (recorder v1.1)', () => {
  it('seeds content and provenance from doc.open payload', async () => {
    const { zipBuffer } = await buildTestBundle({
      sessions: [
        {
          events: [
            {
              kind: 'doc.open',
              data: {
                path: 'hw.py',
                sha256: sha256Hex('# placeholder\n'),
                line_count: 2,
                content: '# placeholder\n',
              },
            },
            {
              kind: 'doc.change',
              data: {
                path: 'hw.py',
                deltas: [
                  {
                    range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } },
                    text: 'h',
                  },
                ],
                source: 'typed',
              },
            },
          ],
        },
      ],
    });

    const bundle = await loadBundleFrom(zipBuffer);
    const index = buildIndex(bundle);
    const state = reconstructFileWithProvenance(index, 'hw.py');

    expect(state.content).toBe('# placeholder\nh');
    expect(state.provenance.length).toBe('# placeholder\nh'.length);

    // Provenance: the first 15 chars (the initial content) should be attributed
    // to the doc.open event; the last char 'h' to the doc.change event.
    const docOpenEvent = index.byKind.get('doc.open')?.[0];
    expect(docOpenEvent).toBeDefined();
    expect(state.kindByGlobalIdx.get(docOpenEvent!.globalIdx)).toBe('preexisting');
    // The 'h' appended by doc.change has a different globalIdx.
    const lastCharIdx = state.provenance[state.provenance.length - 1];
    expect(lastCharIdx).not.toBe(docOpenEvent!.globalIdx);

    // Invariant: content.length === provenance.length
    expect(state.content.length).toBe(state.provenance.length);
  });

  it('parity with v1 reconstructFile: content and hashBySaveSeq match', async () => {
    // Both reconstructors must produce identical content + hashBySaveSeq when
    // doc.open carries a content field.
    const initialContent = '# placeholder\n';
    const finalContent = '# placeholder\ndef main():\n    pass\n';
    const saveHash = sha256Hex(finalContent);

    const { zipBuffer } = await buildTestBundle({
      sessions: [
        {
          events: [
            {
              kind: 'doc.open',
              data: {
                path: 'hw.py',
                sha256: sha256Hex(initialContent),
                line_count: 2,
                content: initialContent,
              },
            },
            {
              kind: 'doc.change',
              data: {
                path: 'hw.py',
                deltas: [
                  {
                    range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } },
                    text: 'def main():\n    pass\n',
                  },
                ],
                source: 'typed',
              },
            },
            {
              kind: 'doc.save',
              data: { path: 'hw.py', sha256: saveHash },
            },
          ],
        },
      ],
    });

    const bundle = await loadBundleFrom(zipBuffer);
    const index = buildIndex(bundle);

    const v1 = reconstructFile(index, 'hw.py');
    const v2 = reconstructFileWithProvenance(index, 'hw.py');

    // Content must be identical.
    expect(v2.content).toBe(v1.content);
    // hashBySaveSeq must be identical.
    expect(v2.hashBySaveSeq.size).toBe(v1.hashBySaveSeq.size);
    for (const [key, hash] of v1.hashBySaveSeq) {
      expect(v2.hashBySaveSeq.get(key)).toBe(hash);
    }

    // Invariant: provenance length matches content length.
    expect(v2.provenance.length).toBe(v2.content.length);
  });

  it('doc.open re-seed clears stale kindByGlobalIdx entries from before reopen', async () => {
    // Regression test for Fix 1: when a file is reopened with new content,
    // all kindByGlobalIdx entries from before the reopen must be cleared.
    // Otherwise stale globalIdx values (which no longer have provenance positions)
    // could leak into Phase 14's gutter consumer.
    const { zipBuffer } = await buildTestBundle({
      sessions: [
        {
          events: [
            {
              kind: 'doc.open',
              data: {
                path: 'test.py',
                sha256: sha256Hex('abc'),
                line_count: 1,
                content: 'abc',
              },
            },
            {
              kind: 'doc.change',
              data: {
                path: 'test.py',
                deltas: [
                  {
                    range: { start: { line: 0, character: 3 }, end: { line: 0, character: 3 } },
                    text: 'd',
                  },
                ],
                source: 'typed',
              },
            },
            {
              kind: 'doc.close',
              data: { path: 'test.py' },
            },
            {
              kind: 'doc.open',
              data: {
                path: 'test.py',
                sha256: sha256Hex('xyz'),
                line_count: 1,
                content: 'xyz',
              },
            },
            {
              kind: 'doc.change',
              data: {
                path: 'test.py',
                deltas: [
                  {
                    range: { start: { line: 0, character: 3 }, end: { line: 0, character: 3 } },
                    text: 'w',
                  },
                ],
                source: 'typed',
              },
            },
          ],
        },
      ],
    });

    const bundle = await loadBundleFrom(zipBuffer);
    const index = buildIndex(bundle);
    const state = reconstructFileWithProvenance(index, 'test.py');

    // Final content is 'xyzw' (from the second reopen)
    expect(state.content).toBe('xyzw');

    // kindByGlobalIdx must NOT contain the first doc.open globalIdx.
    // After the second doc.open, the old globalIdx entries should be cleared.
    const firstDocOpen = index.byKind.get('doc.open')?.[0];
    const secondDocOpen = index.byKind.get('doc.open')?.[1];
    expect(firstDocOpen).toBeDefined();
    expect(secondDocOpen).toBeDefined();

    // The first doc.change globalIdx (from before reopen) should also be cleared
    // because its provenance (from the 'abcd' content) no longer exists.
    const firstDocChange = (index.byKind.get('doc.change') ?? [])[0];
    expect(firstDocChange).toBeDefined();

    // After reopen, kindByGlobalIdx should only contain entries from the second
    // doc.open onwards. The first doc.open and first doc.change should be gone.
    expect(state.kindByGlobalIdx.has(firstDocOpen!.globalIdx)).toBe(false);
    expect(state.kindByGlobalIdx.has(firstDocChange!.globalIdx)).toBe(false);

    // The second doc.open should be in kindByGlobalIdx (seeded as 'preexisting')
    expect(state.kindByGlobalIdx.get(secondDocOpen!.globalIdx)).toBe('preexisting');

    // The second doc.change should be in kindByGlobalIdx (typed)
    const secondDocChange = (index.byKind.get('doc.change') ?? [])[1];
    expect(secondDocChange).toBeDefined();
    expect(state.kindByGlobalIdx.get(secondDocChange!.globalIdx)).toBe('typed');

    // Invariant: no provenance positions reference the stale globalIdx values
    for (const idx of state.provenance) {
      expect(state.kindByGlobalIdx.has(idx)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Recorder v1.2: paste_likely doc.change events tag provenance as 'paste'
// ---------------------------------------------------------------------------

describe('reconstructFileWithProvenance — paste_likely doc.change attribution', () => {
  it('tags a doc.change with source=paste_likely as paste in kindByGlobalIdx (replay gutter)', async () => {
    // Recorder v1.2 routes tool-applied bulk edits through doc.change with
    // source=paste_likely (PRD §4.3). The provenance map drives the replay
    // gutter highlight; if those globalIdx entries get 'typed' instead of
    // 'paste' the gutter shows them as uncolored typing, which defeats the
    // whole purpose of broadening the classifier.
    const longText = 'x'.repeat(50);
    const { zipBuffer } = await buildTestBundle({
      sessions: [
        {
          events: [
            {
              kind: 'doc.change',
              data: {
                path: '/test/file.py',
                deltas: [
                  {
                    range: {
                      start: { line: 0, character: 0 },
                      end: { line: 0, character: 0 },
                    },
                    text: longText,
                  },
                ],
                source: 'paste_likely',
              },
            },
          ],
        },
      ],
    });
    const result = await loadBundle(new Blob([zipBuffer]), 'test.zip');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const index = buildIndex(result.value);
    const state = reconstructFileWithProvenance(index, '/test/file.py');

    const docChange = (index.byKind.get('doc.change') ?? [])[0]!;
    expect(state.kindByGlobalIdx.get(docChange.globalIdx)).toBe('paste');
    // Every char in the file was contributed by this event → all provenance
    // entries point at it.
    expect(state.content).toBe(longText);
    for (const idx of state.provenance) {
      expect(idx).toBe(docChange.globalIdx);
    }
  });

  it('keeps source=typed doc.change as typed (no false positives)', async () => {
    const { zipBuffer } = await buildTestBundle({
      sessions: [
        {
          events: [
            {
              kind: 'doc.change',
              data: {
                path: '/test/file.py',
                deltas: [
                  {
                    range: {
                      start: { line: 0, character: 0 },
                      end: { line: 0, character: 0 },
                    },
                    text: 'hello',
                  },
                ],
                source: 'typed',
              },
            },
          ],
        },
      ],
    });
    const result = await loadBundle(new Blob([zipBuffer]), 'test.zip');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const index = buildIndex(result.value);
    const state = reconstructFileWithProvenance(index, '/test/file.py');

    const docChange = (index.byKind.get('doc.change') ?? [])[0]!;
    expect(state.kindByGlobalIdx.get(docChange.globalIdx)).toBe('typed');
  });
});

// ---------------------------------------------------------------------------
// Over-cap paste recovery — must mirror reconstruct-file.ts exactly.
// See that file's test of the same name for the field case this comes from.
// ---------------------------------------------------------------------------

describe('reconstructFileWithProvenance — over-cap paste recovery', () => {
  const BIG = Array.from({ length: 60 }, (_, i) => `line ${i}: ${'x'.repeat(40)}`).join('\n');
  const path = '/src/big.py';

  const bundleWith = (pasteOverrides: Record<string, unknown> = {}) =>
    buildTestBundle({
      sessions: [
        {
          events: [
            {
              kind: 'doc.open',
              data: { path, content: BIG, sha256: sha256Hex(BIG), line_count: 60 },
            },
            { kind: 'doc.save', data: { path, sha256: sha256Hex(BIG) } },
            {
              kind: 'doc.change',
              data: {
                path,
                deltas: [
                  {
                    range: {
                      start: { line: 0, character: 0 },
                      end: { line: 100000, character: 0 },
                    },
                    text: '',
                  },
                ],
                source: 'typed',
              },
            },
            {
              kind: 'paste',
              data: {
                path,
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                length: new TextEncoder().encode(BIG).length,
                sha256: sha256Hex(BIG),
                content_head: BIG.slice(0, 512),
                content_tail: BIG.slice(-512),
                ...pasteOverrides,
              },
            },
          ],
        },
      ],
    });

  it('recovers the text and attributes every recovered character to the paste', async () => {
    const { zipBuffer } = await bundleWith();
    const index = buildIndex(await loadBundleFrom(zipBuffer));
    const state = reconstructFileWithProvenance(index, path);

    expect(state.content).toBe(BIG);
    const paste = index.byFile.get(path)!.find((e) => e.kind === 'paste')!;
    expect(state.kindByGlobalIdx.get(paste.globalIdx)).toBe('paste');
    expect(state.provenance).toHaveLength(BIG.length);
    expect([...new Set(state.provenance)]).toEqual([paste.globalIdx]);
  });

  it('stays in lockstep with the base replay, recovered or not', async () => {
    for (const overrides of [{}, { content_head: 'Z'.repeat(512) }]) {
      const { zipBuffer } = await bundleWith(overrides);
      const index = buildIndex(await loadBundleFrom(zipBuffer));
      expect(reconstructFileWithProvenance(index, path).content).toBe(
        reconstructFile(index, path).content,
      );
    }
  });
});
