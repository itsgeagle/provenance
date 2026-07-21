/**
 * Tests for reconstruct-file.ts (Phase 3).
 */

import { describe, it, expect } from 'vitest';
import { reconstructFile, applyDocChange, applyPaste } from './reconstruct-file.js';
import { buildIndex } from './build-index.js';
import { loadBundle } from '../loader/parse-bundle.js';
import type { Bundle } from '../loader/types.js';
import { buildTestBundle } from '../test-support/build-test-bundle.js';
import { sha256Hex } from '@provenance/log-core';

// ---------------------------------------------------------------------------
// Helper: load a bundle from a zip buffer.
// ---------------------------------------------------------------------------
async function loadBundleFrom(zipBuffer: ArrayBuffer): Promise<Bundle> {
  const loaded = await loadBundle(new Blob([zipBuffer]), 'test.zip');
  if (!loaded.ok) throw new Error('Expected successful bundle load');
  return loaded.value;
}

// ---------------------------------------------------------------------------
// applyDocChange (unit)
// ---------------------------------------------------------------------------

describe('applyDocChange', () => {
  it('inserts text at the start of an empty string', () => {
    const payload = {
      path: '/a.py',
      deltas: [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          text: 'hello',
        },
      ],
      source: 'typed',
    };
    expect(applyDocChange('', payload)).toBe('hello');
  });

  it('inserts text in the middle of a string', () => {
    const payload = {
      path: '/a.py',
      deltas: [
        {
          range: { start: { line: 0, character: 2 }, end: { line: 0, character: 2 } },
          text: 'XX',
        },
      ],
      source: 'typed',
    };
    expect(applyDocChange('abcde', payload)).toBe('abXXcde');
  });

  it('replaces a range (delete + insert)', () => {
    // Replace characters 1-3 with 'Z'
    const payload = {
      path: '/a.py',
      deltas: [
        {
          range: { start: { line: 0, character: 1 }, end: { line: 0, character: 3 } },
          text: 'Z',
        },
      ],
      source: 'typed',
    };
    expect(applyDocChange('abcde', payload)).toBe('aZde');
  });

  it('deletes a range (insert empty string)', () => {
    const payload = {
      path: '/a.py',
      deltas: [
        {
          range: { start: { line: 0, character: 1 }, end: { line: 0, character: 3 } },
          text: '',
        },
      ],
      source: 'typed',
    };
    expect(applyDocChange('abcde', payload)).toBe('ade');
  });

  it('applies multiple deltas in order', () => {
    // Insert 'X' at start, then insert 'Y' at the new end
    const payload = {
      path: '/a.py',
      deltas: [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          text: 'X',
        },
        {
          range: { start: { line: 0, character: 4 }, end: { line: 0, character: 4 } },
          text: 'Y',
        },
      ],
      source: 'typed',
    };
    // After first delta: 'Xabc'; after second (offset 4): 'XabcY'
    expect(applyDocChange('abc', payload)).toBe('XabcY');
  });

  it('handles multiline content', () => {
    // Insert newline after 'a'
    const payload = {
      path: '/a.py',
      deltas: [
        {
          range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } },
          text: '\n',
        },
      ],
      source: 'typed',
    };
    expect(applyDocChange('ab', payload)).toBe('a\nb');
  });

  it('inserts on a second line', () => {
    const content = 'line0\nline1';
    const payload = {
      path: '/a.py',
      deltas: [
        {
          range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } },
          text: 'X',
        },
      ],
      source: 'typed',
    };
    expect(applyDocChange(content, payload)).toBe('line0\nXline1');
  });

  it('returns original content for non-object payload', () => {
    expect(applyDocChange('abc', null)).toBe('abc');
    expect(applyDocChange('abc', 'bad')).toBe('abc');
  });

  it('returns original content if deltas is not an array', () => {
    expect(applyDocChange('abc', { deltas: 'bad' })).toBe('abc');
  });

  it('applies multiple deltas in reverse document order (VS Code contract)', () => {
    // Regression test: VS Code emits deltas in reverse document order (bottom-to-top,
    // rightmost-first) so each delta's range is valid against the pre-mutation state.
    // The recorder stores them verbatim in that order, and applyDocChange must apply
    // them in array order without sorting.
    //
    // Example: content 'abcdef'. Delete [0,2] (remove 'ab') and delete [4,5] (remove 'e').
    // In reverse document order: [4,5] first (removes 'e'), then [0,2] (removes 'ab').
    // Stored in payload as [{range:[4,5], text:''}, {range:[0,2], text:''}].
    // Applying in array order:
    //  - Apply [4,5] on 'abcdef' → 'abcdf'
    //  - Apply [0,2] on 'abcdf' → 'cdf'
    const payload = {
      path: '/a.py',
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
    };
    expect(applyDocChange('abcdef', payload)).toBe('cdf');

    // Counterexample (for documentation): if deltas were misordered (ascending by start),
    // applying [{range:[0,2], text:''}, {range:[4,5], text:''}] would yield wrong result:
    //  - Apply [0,2] on 'abcdef' → 'cdef'
    //  - Apply [4,5] on 'cdef' → tries to delete [4,5] of 'cdef', but cdef[4] is 'f', not 'e'.
    //    Range clamping shifts the delete to [3,4] (or beyond the string), yielding 'cde' or 'cdf'.
    // This is why the ordering matters: the reversal ensures each range is valid as-is.
  });
});

// ---------------------------------------------------------------------------
// applyPaste (unit)
// ---------------------------------------------------------------------------

describe('applyPaste', () => {
  it('applies an inline paste (content field present)', () => {
    const payload = {
      path: '/a.py',
      range: { start: { line: 0, character: 2 }, end: { line: 0, character: 2 } },
      length: 5,
      sha256: 'abc',
      content: 'PASTE',
    };
    const { content, applied } = applyPaste('hello world', payload);
    expect(applied).toBe(true);
    expect(content).toBe('hePASTEllo world');
  });

  it('replaces a range when content is present', () => {
    const payload = {
      path: '/a.py',
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
      length: 2,
      sha256: 'abc',
      content: 'HI',
    };
    const { content, applied } = applyPaste('hello', payload);
    expect(applied).toBe(true);
    expect(content).toBe('HIlo');
  });

  it('returns applied=false for large paste (no content field)', () => {
    const payload = {
      path: '/a.py',
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      length: 9999,
      sha256: 'abc',
      content_head: 'abcde',
      content_tail: 'vwxyz',
    };
    const { content, applied } = applyPaste('hello', payload);
    expect(applied).toBe(false);
    expect(content).toBe('hello'); // unchanged
  });

  it('returns applied=false for non-object payload', () => {
    const { applied } = applyPaste('hello', null);
    expect(applied).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// reconstructFile — integration via bundle
// ---------------------------------------------------------------------------

describe('reconstructFile — basic reconstruction', () => {
  it('reconstructs a file after sequential inserts', async () => {
    // The test bundle helper inserts 'x1', 'x2', 'x3' prepended each time.
    // After 3 events the content is 'x3x2x1'.
    const { zipBuffer } = await buildTestBundle({ sessions: [{ eventCount: 3 }] });
    const bundle = await loadBundleFrom(zipBuffer);
    const index = buildIndex(bundle);
    const recon = reconstructFile(index, '/test/file.py');

    expect(recon.content).toBe('x3x2x1');
    expect(recon.tainted).toBe(false);
    expect(recon.taintReasons).toHaveLength(0);
    expect(recon.hashBySaveSeq.size).toBe(0); // no doc.save in default bundle
  });

  it('returns empty content for an unknown file path', async () => {
    const { zipBuffer } = await buildTestBundle({ sessions: [{ eventCount: 2 }] });
    const bundle = await loadBundleFrom(zipBuffer);
    const index = buildIndex(bundle);
    const recon = reconstructFile(index, '/nonexistent/file.py');

    expect(recon.content).toBe('');
    expect(recon.tainted).toBe(false);
    expect(recon.hashBySaveSeq.size).toBe(0);
  });

  it('records doc.save sha256 in hashBySaveSeq', async () => {
    const finalContent = 'x1'; // eventCount=1 → 'x1'
    const saveHash = sha256Hex(finalContent);

    const { zipBuffer } = await buildTestBundle({
      sessions: [{ eventCount: 1, appendDocSave: true }],
    });
    const bundle = await loadBundleFrom(zipBuffer);
    const index = buildIndex(bundle);
    const recon = reconstructFile(index, '/test/file.py');

    expect(recon.tainted).toBe(false);
    expect(recon.hashBySaveSeq.size).toBe(1);

    // The hash in the map should be the one from the doc.save payload.
    const [key, hash] = [...recon.hashBySaveSeq.entries()][0]!;
    expect(key).toMatch(/^[0-9a-f-]+:\d+$/);
    expect(hash).toBe(saveHash);
  });

  it('reconstruction matches doc.save sha256 (exit-gate sanity)', async () => {
    // Build a bundle with a doc.save whose sha256 is computed from the
    // reconstructed content. Verify they match.
    const { zipBuffer } = await buildTestBundle({
      sessions: [{ eventCount: 3, appendDocSave: true }],
    });
    const bundle = await loadBundleFrom(zipBuffer);
    const index = buildIndex(bundle);
    const recon = reconstructFile(index, '/test/file.py');

    expect(recon.tainted).toBe(false);
    expect(recon.hashBySaveSeq.size).toBe(1);

    const recordedHash = [...recon.hashBySaveSeq.values()][0]!;
    const computedHash = sha256Hex(recon.content);
    expect(computedHash).toBe(recordedHash);
  });
});

// ---------------------------------------------------------------------------
// reconstructFile — upToGlobalIdx
// ---------------------------------------------------------------------------

describe('reconstructFile — upToGlobalIdx', () => {
  it('stops before the event at upToGlobalIdx', async () => {
    // 3 events: seq1 inserts 'x1', seq2 inserts 'x2', seq3 inserts 'x3'.
    // content after all 3: 'x3x2x1'.
    // content after first 2: 'x2x1'.
    const { zipBuffer } = await buildTestBundle({ sessions: [{ eventCount: 3 }] });
    const bundle = await loadBundleFrom(zipBuffer);
    const index = buildIndex(bundle);

    // Find globalIdx of the third doc.change (seq=3).
    const changes = index.byKind.get('doc.change') ?? [];
    const thirdChange = changes.find((e) => e.seq === 3);
    expect(thirdChange).toBeDefined();

    // Reconstruct up to (but not including) the third change.
    const recon = reconstructFile(index, '/test/file.py', thirdChange!.globalIdx);
    expect(recon.content).toBe('x2x1');
  });

  it('returns empty content when upToGlobalIdx is 0', async () => {
    const { zipBuffer } = await buildTestBundle({ sessions: [{ eventCount: 3 }] });
    const bundle = await loadBundleFrom(zipBuffer);
    const index = buildIndex(bundle);
    const recon = reconstructFile(index, '/test/file.py', 0);
    expect(recon.content).toBe('');
  });
});

// ---------------------------------------------------------------------------
// reconstructFile — taint scenarios
// ---------------------------------------------------------------------------

describe('reconstructFile — taint: fs.external_change', () => {
  it('marks file as tainted after fs.external_change', async () => {
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
                    text: 'original',
                  },
                ],
                source: 'typed',
              },
            },
            {
              kind: 'fs.external_change',
              data: {
                path: '/src/app.py',
                old_hash: 'aaa',
                new_hash: 'bbb',
                diff_size: 10,
              },
            },
            {
              kind: 'doc.change',
              data: {
                path: '/src/app.py',
                deltas: [
                  {
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                    text: 'after_external',
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
    const recon = reconstructFile(index, '/src/app.py');

    expect(recon.tainted).toBe(true);
    expect(recon.taintReasons).toHaveLength(1);
    expect(recon.taintReasons[0]?.reason).toBe('fs_external_change');
    // POLICY (changed 2026-07): taint no longer zeroes content or discards the
    // rest of the stream. We cannot see what the external write did, so the
    // result is unreliable -- `tainted` says so -- but the surrounding content
    // and every later edit are kept. '' is never the true content; stale
    // content frequently still is. Evidence: 8 submissions in a 156-bundle
    // corpus reproduce their SIGNED manifest sha256 under this policy and
    // reconstructed to empty under the old one.
    expect(recon.content).toBe('after_externaloriginal');
  });

  it('still records doc.save hashes when tainted', async () => {
    const { zipBuffer } = await buildTestBundle({
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
            {
              kind: 'doc.save',
              data: { path: '/src/app.py', sha256: 'some-hash-from-recorder' },
            },
          ],
        },
      ],
    });

    const bundle = await loadBundleFrom(zipBuffer);
    const index = buildIndex(bundle);
    const recon = reconstructFile(index, '/src/app.py');

    expect(recon.tainted).toBe(true);
    // hashBySaveSeq is always populated regardless of taint.
    expect(recon.hashBySaveSeq.size).toBe(1);
    const [, hash] = [...recon.hashBySaveSeq.entries()][0]!;
    expect(hash).toBe('some-hash-from-recorder');
  });
});

describe('reconstructFile — fs.external_change with new_content (recorder v1.3+)', () => {
  it('reseeds content from new_content; tainted=false; subsequent doc.change applies', async () => {
    const after = 'def foo(): return 42\n';
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
                    text: 'original\n',
                  },
                ],
                source: 'typed',
              },
            },
            {
              kind: 'fs.external_change',
              data: {
                path: '/src/app.py',
                old_hash: 'aaa',
                new_hash: 'bbb',
                diff_size: after.length,
                new_content: after,
                new_content_size: after.length,
              },
            },
            {
              kind: 'doc.change',
              data: {
                path: '/src/app.py',
                deltas: [
                  {
                    range: {
                      start: { line: 1, character: 0 },
                      end: { line: 1, character: 0 },
                    },
                    text: '# more\n',
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
    const recon = reconstructFile(index, '/src/app.py');

    // tainted is false because content is reconstructable from new_content.
    expect(recon.tainted).toBe(false);
    // taintReasons still records the event for downstream consumers.
    expect(recon.taintReasons).toHaveLength(1);
    expect(recon.taintReasons[0]?.reason).toBe('fs_external_change');
    // Subsequent doc.change applies on top of the reseeded content.
    expect(recon.content).toBe('def foo(): return 42\n# more\n');
  });

  it('operation:delete clears content + taints, even when no new_content', async () => {
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
                    text: 'original',
                  },
                ],
                source: 'typed',
              },
            },
            {
              kind: 'fs.external_change',
              data: {
                path: '/src/app.py',
                operation: 'delete',
                old_hash: 'aaa',
                new_hash: '',
                diff_size: 8,
              },
            },
          ],
        },
      ],
    });

    const bundle = await loadBundleFrom(zipBuffer);
    const index = buildIndex(bundle);
    const recon = reconstructFile(index, '/src/app.py');

    expect(recon.tainted).toBe(true);
    expect(recon.content).toBe('');
    expect(recon.taintReasons[0]?.reason).toBe('fs_external_change');
  });

  it('operation:create seeds content from new_content without tainting', async () => {
    const newContent = 'def fresh(): return 1\n';
    const { zipBuffer } = await buildTestBundle({
      sessions: [
        {
          events: [
            {
              kind: 'fs.external_change',
              data: {
                path: '/src/app.py',
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
    const recon = reconstructFile(index, '/src/app.py');

    expect(recon.tainted).toBe(false);
    expect(recon.content).toBe(newContent);
    expect(recon.taintReasons[0]?.reason).toBe('fs_external_change');
  });

  it('taints but preserves content when new_content is absent (>4 KB file)', async () => {
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
                    text: 'original',
                  },
                ],
                source: 'typed',
              },
            },
            {
              kind: 'fs.external_change',
              data: {
                path: '/src/app.py',
                old_hash: 'aaa',
                new_hash: 'bbb',
                diff_size: 10,
                // No new_content — pre-v1.3 bundle.
              },
            },
          ],
        },
      ],
    });

    const bundle = await loadBundleFrom(zipBuffer);
    const index = buildIndex(bundle);
    const recon = reconstructFile(index, '/src/app.py');

    expect(recon.tainted).toBe(true);
    // Unreliable, but not discarded -- see the policy note above.
    expect(recon.content).toBe('original');
  });

  it('DOES zero content on operation:delete (the file really is gone)', async () => {
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
                    text: 'original',
                  },
                ],
                source: 'typed',
              },
            },
            {
              kind: 'fs.external_change',
              data: {
                path: '/src/app.py',
                old_hash: 'aaa',
                new_hash: '',
                diff_size: 8,
                operation: 'delete',
              },
            },
          ],
        },
      ],
    });

    const bundle = await loadBundleFrom(zipBuffer);
    const index = buildIndex(bundle);
    const recon = reconstructFile(index, '/src/app.py');

    expect(recon.tainted).toBe(true);
    expect(recon.content).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Self-inflicted fs.external_change (D1) + taint recovery (D2).
//
// Recorders <= VS Code 1.1.x / JetBrains emit a bogus fs.external_change when a
// keystroke lands inside the async window between the editor writing the file
// and the recorder reading it back. The signature is exact: the very next event
// for the file is a doc.save, in the same session, whose sha256 equals the
// change's new_hash, at effectively the same wall clock — because both are
// emitted from the same handler continuation.
//
// See .notes/external-change-false-positives.md. 3316 such events were found
// across a 156-bundle corpus; the discriminator matched 3316/3316.
// ---------------------------------------------------------------------------

/** Both events carry the same wall so the adjacency window is unambiguous. */
const SAME_WALL = '2026-01-01T00:05:00.000Z';

describe('reconstructFile — self-inflicted fs.external_change (D1)', () => {
  it('does not taint when the next doc.save has the same hash (recorder save race)', async () => {
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
                    text: 'hello',
                  },
                ],
                source: 'typed',
              },
            },
            {
              kind: 'fs.external_change',
              wall: SAME_WALL,
              data: {
                path: '/src/app.py',
                old_hash: 'bbb',
                new_hash: 'aaa',
                diff_size: 1,
                operation: 'modify',
                // >4 KB file: no new_content, which is what makes this fatal today.
              },
            },
            {
              kind: 'doc.save',
              wall: SAME_WALL,
              data: { path: '/src/app.py', sha256: 'aaa' },
            },
            {
              kind: 'doc.change',
              data: {
                path: '/src/app.py',
                deltas: [
                  {
                    range: { start: { line: 0, character: 5 }, end: { line: 0, character: 5 } },
                    text: ' world',
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
    const recon = reconstructFile(index, '/src/app.py');

    // The event never happened: no taint, no taint reason, and — critically —
    // the deltas after it still apply.
    expect(recon.tainted).toBe(false);
    expect(recon.taintReasons).toHaveLength(0);
    expect(recon.content).toBe('hello world');
    // Still surfaced for the UI so staff can see what was reclassified.
    expect(recon.suppressedExternalChanges).toHaveLength(1);
  });

  it('STILL taints when the next doc.save hash differs (genuine external write)', async () => {
    // Anti-regression: the D1 fix must not buy quiet by going blind to real
    // external writes. That failure mode is worse than the bug.
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
                    text: 'hello',
                  },
                ],
                source: 'typed',
              },
            },
            {
              kind: 'fs.external_change',
              wall: SAME_WALL,
              data: {
                path: '/src/app.py',
                old_hash: 'bbb',
                new_hash: 'ccc',
                diff_size: 4000,
                operation: 'modify',
              },
            },
            {
              // Different hash → the disk state was NOT what the editor saved.
              kind: 'doc.save',
              wall: SAME_WALL,
              data: { path: '/src/app.py', sha256: 'ddd' },
            },
          ],
        },
      ],
    });

    const bundle = await loadBundleFrom(zipBuffer);
    const index = buildIndex(bundle);
    const recon = reconstructFile(index, '/src/app.py');

    expect(recon.tainted).toBe(true);
    expect(recon.taintReasons).toHaveLength(1);
    expect(recon.taintReasons[0]?.reason).toBe('fs_external_change');
    expect(recon.suppressedExternalChanges).toHaveLength(0);
  });

  it('does not suppress when the matching doc.save is far away in wall clock', async () => {
    // A tool writes the file, then a human saves identical content much later.
    // Human reaction time >> the same-continuation emit, so the window separates
    // them. Keeping this window tight is what bounds the false-negative risk.
    const { zipBuffer } = await buildTestBundle({
      sessions: [
        {
          events: [
            {
              kind: 'fs.external_change',
              wall: '2026-01-01T00:05:00.000Z',
              data: {
                path: '/src/app.py',
                old_hash: 'bbb',
                new_hash: 'aaa',
                diff_size: 4000,
                operation: 'modify',
              },
            },
            {
              kind: 'doc.save',
              wall: '2026-01-01T00:05:30.000Z', // 30s later
              data: { path: '/src/app.py', sha256: 'aaa' },
            },
          ],
        },
      ],
    });

    const bundle = await loadBundleFrom(zipBuffer);
    const index = buildIndex(bundle);
    const recon = reconstructFile(index, '/src/app.py');

    expect(recon.tainted).toBe(true);
    expect(recon.suppressedExternalChanges).toHaveLength(0);
  });

  it('looks past selection.change events when finding the following save', async () => {
    // `byFile` carries selection.change too (it has a `path`), and a cursor move
    // routinely lands between the bogus event and the doc.save emitted from the
    // same continuation. Anchoring on the literal next element made the rule
    // miss those. A caret move is not a content event, so it can never be
    // evidence that something wrote the file.
    const { zipBuffer } = await buildTestBundle({
      sessions: [
        {
          events: [
            {
              kind: 'doc.change',
              wall: '2026-01-01T00:05:00.000Z',
              data: {
                path: '/src/app.py',
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
              kind: 'fs.external_change',
              wall: '2026-01-01T00:05:01.000Z',
              data: {
                path: '/src/app.py',
                old_hash: 'bbb',
                new_hash: 'aaa',
                diff_size: 1,
                operation: 'modify',
              },
            },
            {
              // The caret moves between the two — this is what defeated the rule.
              kind: 'selection.change',
              wall: '2026-01-01T00:05:01.001Z',
              data: {
                path: '/src/app.py',
                range: { start: { line: 0, character: 5 }, end: { line: 0, character: 5 } },
                was_selection: false,
              },
            },
            {
              kind: 'doc.save',
              wall: '2026-01-01T00:05:01.002Z',
              data: { path: '/src/app.py', sha256: 'aaa' },
            },
          ],
        },
      ],
    });

    const bundle = await loadBundleFrom(zipBuffer);
    const index = buildIndex(bundle);
    const recon = reconstructFile(index, '/src/app.py');

    expect(recon.tainted).toBe(false);
    expect(recon.taintReasons).toHaveLength(0);
    expect(recon.suppressedExternalChanges).toHaveLength(1);
  });

  it('does NOT look past a doc.change when finding the following save', async () => {
    // Only non-content events are skipped. An intervening edit means the save
    // that follows is a different save than the one the bogus event rode in
    // with, so the same-continuation timing argument no longer holds.
    const { zipBuffer } = await buildTestBundle({
      sessions: [
        {
          events: [
            {
              kind: 'fs.external_change',
              wall: '2026-01-01T00:05:01.000Z',
              data: {
                path: '/src/app.py',
                old_hash: 'bbb',
                new_hash: 'aaa',
                diff_size: 4000,
                operation: 'modify',
              },
            },
            {
              kind: 'doc.change',
              wall: '2026-01-01T00:05:01.200Z',
              data: {
                path: '/src/app.py',
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
              // Inside D1's 1 s window: only the intervening edit stops the rule.
              kind: 'doc.save',
              wall: '2026-01-01T00:05:01.400Z',
              data: { path: '/src/app.py', sha256: 'aaa' },
            },
          ],
        },
      ],
    });

    const bundle = await loadBundleFrom(zipBuffer);
    const index = buildIndex(bundle);
    const recon = reconstructFile(index, '/src/app.py');

    expect(recon.tainted).toBe(true);
    expect(recon.suppressedExternalChanges).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// D1b: the fs-watcher-path half of the same recorder defect.
//
// The save-path false positive (D1 above) is recognised by a FOLLOWING doc.save
// whose sha256 matches. The fs-watcher path produces the mirror image: the
// watcher fires for the editor's own write, reads disk asynchronously, and by
// the time the read resolves the student has typed on. The event then reports
// old_hash = the live buffer and new_hash = the state the editor last SAVED —
// so the matching doc.save PRECEDES it and the D1 rule never fires.
//
// Discriminator: new_hash equals the sha256 of the nearest preceding doc.save
// for this file in this session. That means the disk held exactly the bytes the
// editor itself last wrote, so no foreign content was ever present. This is a
// content-identity argument, not a timing one, which is why it needs no window.
//
// See .notes/external-change-false-positives.md ("Open question that blocks
// item 4's scope" — these events were previously misfiled as genuine).
// ---------------------------------------------------------------------------

describe('reconstructFile — self-inflicted fs.external_change, watcher path (D1b)', () => {
  it('does not taint when new_hash matches the nearest PRECEDING doc.save', async () => {
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
                    text: 'hello',
                  },
                ],
                source: 'typed',
              },
            },
            {
              // The editor saves "hello" — disk now holds hash 'aaa'.
              kind: 'doc.save',
              wall: '2026-01-01T00:05:00.000Z',
              data: { path: '/src/app.py', sha256: 'aaa' },
            },
            {
              // The student types on; the model is now ahead of disk.
              kind: 'doc.change',
              data: {
                path: '/src/app.py',
                deltas: [
                  {
                    range: { start: { line: 0, character: 5 }, end: { line: 0, character: 5 } },
                    text: ' world',
                  },
                ],
                source: 'typed',
              },
            },
            {
              // The watcher's late read of the editor's own write: old_hash is
              // the live buffer, new_hash is the already-saved disk state.
              kind: 'fs.external_change',
              wall: '2026-01-01T00:05:02.000Z',
              data: {
                path: '/src/app.py',
                old_hash: 'bbb',
                new_hash: 'aaa',
                diff_size: 6,
                operation: 'modify',
              },
            },
            {
              kind: 'doc.change',
              data: {
                path: '/src/app.py',
                deltas: [
                  {
                    range: { start: { line: 0, character: 11 }, end: { line: 0, character: 11 } },
                    text: '!',
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
    const recon = reconstructFile(index, '/src/app.py');

    expect(recon.tainted).toBe(false);
    expect(recon.taintReasons).toHaveLength(0);
    expect(recon.content).toBe('hello world!');
    expect(recon.suppressedExternalChanges).toHaveLength(1);
  });

  it('STILL taints when new_hash is content no doc.save ever wrote', async () => {
    // Anti-regression: a genuine external write after a save must survive. The
    // rule only ever forgives disk content the editor itself produced.
    const { zipBuffer } = await buildTestBundle({
      sessions: [
        {
          events: [
            {
              kind: 'doc.save',
              wall: '2026-01-01T00:05:00.000Z',
              data: { path: '/src/app.py', sha256: 'aaa' },
            },
            {
              kind: 'fs.external_change',
              wall: '2026-01-01T00:05:02.000Z',
              data: {
                path: '/src/app.py',
                old_hash: 'aaa',
                new_hash: 'ccc',
                diff_size: 4000,
                operation: 'modify',
              },
            },
          ],
        },
      ],
    });

    const bundle = await loadBundleFrom(zipBuffer);
    const index = buildIndex(bundle);
    const recon = reconstructFile(index, '/src/app.py');

    expect(recon.tainted).toBe(true);
    expect(recon.taintReasons).toHaveLength(1);
    expect(recon.suppressedExternalChanges).toHaveLength(0);
  });

  it('STILL taints when disk holds a save older than the most recent one', async () => {
    // Disk rewound past the latest save — something outside the editor put an
    // earlier state back on disk. "Nearest preceding save" is load-bearing:
    // matching against ANY earlier save would wrongly forgive this.
    const { zipBuffer } = await buildTestBundle({
      sessions: [
        {
          events: [
            {
              kind: 'doc.save',
              wall: '2026-01-01T00:05:00.000Z',
              data: { path: '/src/app.py', sha256: 'aaa' },
            },
            {
              kind: 'doc.save',
              wall: '2026-01-01T00:05:10.000Z',
              data: { path: '/src/app.py', sha256: 'bbb' },
            },
            {
              kind: 'fs.external_change',
              wall: '2026-01-01T00:05:20.000Z',
              data: {
                path: '/src/app.py',
                old_hash: 'bbb',
                new_hash: 'aaa', // an OLDER save, not the nearest one
                diff_size: 500,
                operation: 'modify',
              },
            },
          ],
        },
      ],
    });

    const bundle = await loadBundleFrom(zipBuffer);
    const index = buildIndex(bundle);
    const recon = reconstructFile(index, '/src/app.py');

    expect(recon.tainted).toBe(true);
    expect(recon.suppressedExternalChanges).toHaveLength(0);
  });

  it('does not match a preceding doc.save from a different session', async () => {
    // `t` and the expected-content model are session-local; a save in another
    // session says nothing about what this session's recorder saw on disk.
    const { zipBuffer } = await buildTestBundle({
      sessions: [
        {
          events: [
            {
              kind: 'doc.save',
              wall: '2026-01-01T00:05:00.000Z',
              data: { path: '/src/app.py', sha256: 'aaa' },
            },
          ],
        },
        {
          events: [
            {
              kind: 'fs.external_change',
              wall: '2026-01-01T00:05:02.000Z',
              data: {
                path: '/src/app.py',
                old_hash: 'bbb',
                new_hash: 'aaa',
                diff_size: 6,
                operation: 'modify',
              },
            },
          ],
        },
      ],
    });

    const bundle = await loadBundleFrom(zipBuffer);
    const index = buildIndex(bundle);
    const recon = reconstructFile(index, '/src/app.py');

    expect(recon.tainted).toBe(true);
    expect(recon.suppressedExternalChanges).toHaveLength(0);
  });

  it('does not forgive a delete just because disk matched the last save', async () => {
    // Only `modify` is ever this bug. A create/delete is always real.
    const { zipBuffer } = await buildTestBundle({
      sessions: [
        {
          events: [
            {
              kind: 'doc.save',
              wall: '2026-01-01T00:05:00.000Z',
              data: { path: '/src/app.py', sha256: 'aaa' },
            },
            {
              kind: 'fs.external_change',
              wall: '2026-01-01T00:05:02.000Z',
              data: {
                path: '/src/app.py',
                old_hash: 'aaa',
                new_hash: 'aaa',
                diff_size: 0,
                operation: 'delete',
              },
            },
          ],
        },
      ],
    });

    const bundle = await loadBundleFrom(zipBuffer);
    const index = buildIndex(bundle);
    const recon = reconstructFile(index, '/src/app.py');

    expect(recon.tainted).toBe(true);
    expect(recon.suppressedExternalChanges).toHaveLength(0);
  });
});

describe('reconstructFile — taint is recoverable (D2)', () => {
  it('re-anchors on a later doc.open that carries content, clearing taint', async () => {
    const reopened = 'def solve():\n    return 42\n';
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
                    text: 'original',
                  },
                ],
                source: 'typed',
              },
            },
            {
              // Genuine, contentless → taints (correctly).
              kind: 'fs.external_change',
              data: {
                path: '/src/app.py',
                old_hash: 'aaa',
                new_hash: 'bbb',
                diff_size: 5000,
                operation: 'modify',
              },
            },
            {
              // A later open re-establishes ground truth. Before the D2 fix the
              // taint was permanent and everything past it was discarded.
              kind: 'doc.open',
              data: { path: '/src/app.py', content: reopened },
            },
            {
              kind: 'doc.change',
              data: {
                path: '/src/app.py',
                deltas: [
                  {
                    range: { start: { line: 1, character: 14 }, end: { line: 1, character: 14 } },
                    text: '  # done',
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
    const recon = reconstructFile(index, '/src/app.py');

    // The gap is still recorded — staff must see that an external write happened —
    // but reconstruction recovers instead of dying.
    expect(recon.taintReasons).toHaveLength(1);
    expect(recon.taintReasons[0]?.reason).toBe('fs_external_change');
    expect(recon.tainted).toBe(false);
    expect(recon.content).toBe('def solve():\n    return 42  # done\n');
  });
});

describe('reconstructFile — taint: large paste', () => {
  it('marks file as tainted on large paste (no content field)', async () => {
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
                content_head: 'first few chars',
                content_tail: 'last few chars',
                // No `content` field → large paste.
              },
            },
          ],
        },
      ],
    });

    const bundle = await loadBundleFrom(zipBuffer);
    const index = buildIndex(bundle);
    const recon = reconstructFile(index, '/src/big.py');

    expect(recon.tainted).toBe(true);
    expect(recon.taintReasons).toHaveLength(1);
    expect(recon.taintReasons[0]?.reason).toBe('large_paste');
    // The pasted text is unknown, but the surrounding content is not -- keep it.
    expect(recon.content).toBe('before');
  });

  it('applies inline paste (content field present) without taint', async () => {
    const { zipBuffer } = await buildTestBundle({
      sessions: [
        {
          events: [
            {
              kind: 'doc.change',
              data: {
                path: '/src/small.py',
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
                path: '/src/small.py',
                range: { start: { line: 0, character: 3 }, end: { line: 0, character: 3 } },
                length: 5,
                sha256: 'inlinehash',
                content: 'PASTE', // inline content → applied
              },
            },
          ],
        },
      ],
    });

    const bundle = await loadBundleFrom(zipBuffer);
    const index = buildIndex(bundle);
    const recon = reconstructFile(index, '/src/small.py');

    expect(recon.tainted).toBe(false);
    expect(recon.content).toBe('ABCPASTE');
  });
});

// ---------------------------------------------------------------------------
// reconstructFile — over-cap paste recovery
//
// Field case (submission 418831297, session 1bcfc6aa, globalIdx 7131): the
// student selected all and pasted the file back over itself. The paste was
// 14 539 B against a 4 KB inline cap, so only head/tail were recorded and the
// replay could not apply it. With no later `doc.open` in that session, the file
// stayed empty for the remaining 5 300 events — 270 consecutive save
// checkpoints failed.
//
// The pasted text was byte-identical to a document state the replay had already
// reproduced, and `paste.sha256` identifies it exactly, so it is recoverable
// without guessing. These tests pin that, and pin that the head/tail gate is
// load-bearing rather than decorative.
// ---------------------------------------------------------------------------

/** A multi-line blob long enough that head/tail (512 chars) are partial slices. */
const BIG = Array.from({ length: 60 }, (_, i) => `line ${i}: ${'x'.repeat(40)}`).join('\n');

/** A doc.change that deletes the whole document (end position clamps to EOF). */
const deleteAll = (path: string) => ({
  kind: 'doc.change',
  data: {
    path,
    deltas: [
      {
        range: { start: { line: 0, character: 0 }, end: { line: 100000, character: 0 } },
        text: '',
      },
    ],
    source: 'typed',
  },
});

/** An over-cap paste payload: hash + head/tail only, no inline `content`. */
const overCapPaste = (path: string, text: string, overrides: Record<string, unknown> = {}) => ({
  kind: 'paste',
  data: {
    path,
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    length: new TextEncoder().encode(text).length,
    sha256: sha256Hex(text),
    content_head: text.slice(0, 512),
    content_tail: text.slice(-512),
    ...overrides,
  },
});

describe('reconstructFile — over-cap paste recovery', () => {
  it('recovers an over-cap paste whose text matches an earlier reconstructed state', async () => {
    const path = '/src/big.py';
    const { zipBuffer } = await buildTestBundle({
      sessions: [
        {
          events: [
            {
              kind: 'doc.open',
              data: { path, content: BIG, sha256: sha256Hex(BIG), line_count: 60 },
            },
            { kind: 'doc.save', data: { path, sha256: sha256Hex(BIG) } },
            deleteAll(path),
            overCapPaste(path, BIG),
            { kind: 'doc.save', data: { path, sha256: sha256Hex(BIG) } },
          ],
        },
      ],
    });

    const bundle = await loadBundleFrom(zipBuffer);
    const index = buildIndex(bundle);
    const recon = reconstructFile(index, path);

    expect(recon.content).toBe(BIG);
    // Recovery is verified against the recorded sha256, so the result is ground
    // truth -- the reconstruction is trustworthy again.
    expect(recon.tainted).toBe(false);
    // ...but the gap still happened and staff must still see it.
    expect(recon.taintReasons.map((t) => t.reason)).toEqual(['large_paste']);
    const paste = index.byFile.get(path)!.find((e) => e.kind === 'paste')!;
    expect(recon.recoveredPastes).toEqual([paste.globalIdx]);
  });

  it('splices the recovered text into the paste range rather than replacing the document', async () => {
    const path = '/src/big.py';
    const { zipBuffer } = await buildTestBundle({
      sessions: [
        {
          events: [
            {
              kind: 'doc.open',
              data: { path, content: BIG, sha256: sha256Hex(BIG), line_count: 60 },
            },
            { kind: 'doc.save', data: { path, sha256: sha256Hex(BIG) } },
            deleteAll(path),
            {
              kind: 'doc.change',
              data: {
                path,
                deltas: [
                  {
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                    text: 'AB',
                  },
                ],
                source: 'typed',
              },
            },
            overCapPaste(path, BIG, {
              range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } },
            }),
          ],
        },
      ],
    });

    const bundle = await loadBundleFrom(zipBuffer);
    const index = buildIndex(bundle);
    const recon = reconstructFile(index, path);

    expect(recon.content).toBe(`A${BIG}B`);
  });

  it('refuses to recover when the recorded head/tail disagree with the candidate', async () => {
    const path = '/src/big.py';
    const { zipBuffer } = await buildTestBundle({
      sessions: [
        {
          events: [
            {
              kind: 'doc.open',
              data: { path, content: BIG, sha256: sha256Hex(BIG), line_count: 60 },
            },
            { kind: 'doc.save', data: { path, sha256: sha256Hex(BIG) } },
            deleteAll(path),
            // sha256 still matches the stored blob, but the head does not. The
            // hash alone would accept this; the cross-check must reject it.
            overCapPaste(path, BIG, { content_head: 'Z'.repeat(512) }),
          ],
        },
      ],
    });

    const bundle = await loadBundleFrom(zipBuffer);
    const index = buildIndex(bundle);
    const recon = reconstructFile(index, path);

    expect(recon.content).toBe('');
    expect(recon.tainted).toBe(true);
    expect(recon.recoveredPastes).toEqual([]);
  });

  it('leaves the file tainted when no earlier state matches the paste hash', async () => {
    const path = '/src/big.py';
    const { zipBuffer } = await buildTestBundle({
      sessions: [
        {
          events: [
            {
              kind: 'doc.open',
              data: { path, content: BIG, sha256: sha256Hex(BIG), line_count: 60 },
            },
            overCapPaste(path, `${BIG}never-reconstructed`),
          ],
        },
      ],
    });

    const bundle = await loadBundleFrom(zipBuffer);
    const index = buildIndex(bundle);
    const recon = reconstructFile(index, path);

    // Unknown text: keep the surrounding content, mark it unreliable.
    expect(recon.content).toBe(BIG);
    expect(recon.tainted).toBe(true);
    expect(recon.recoveredPastes).toEqual([]);
  });

  it('does not remember a blob whose recorded save hash disagrees with our model', async () => {
    const path = '/src/big.py';
    const { zipBuffer } = await buildTestBundle({
      sessions: [
        {
          events: [
            {
              kind: 'doc.open',
              data: { path, content: 'seed\n', sha256: sha256Hex('seed\n'), line_count: 2 },
            },
            // The recorder claims the file on disk hashes to sha256Hex(BIG), but
            // our reconstruction holds 'seed\n'. Storing our buffer under that
            // hash would hand the paste the wrong bytes.
            { kind: 'doc.save', data: { path, sha256: sha256Hex(BIG) } },
            overCapPaste(path, BIG),
          ],
        },
      ],
    });

    const bundle = await loadBundleFrom(zipBuffer);
    const index = buildIndex(bundle);
    const recon = reconstructFile(index, path);

    expect(recon.content).toBe('seed\n');
    expect(recon.tainted).toBe(true);
    expect(recon.recoveredPastes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// reconstructFile — exit gate: sha256 match against fixture saves
// ---------------------------------------------------------------------------

describe('reconstructFile — exit gate: sha256 matches recorded saves', () => {
  it('computed sha256 matches doc.save payload for all saves in a clean session', async () => {
    // Build 3 doc.change events + a matching doc.save.
    const { zipBuffer } = await buildTestBundle({
      sessions: [{ eventCount: 3, appendDocSave: true }],
    });
    const bundle = await loadBundleFrom(zipBuffer);
    const index = buildIndex(bundle);
    const recon = reconstructFile(index, '/test/file.py');

    expect(recon.tainted).toBe(false);

    for (const [key, recordedHash] of recon.hashBySaveSeq) {
      // Find the globalIdx of this save in the index.
      const colonIdx = key.lastIndexOf(':');
      const sessionId = key.slice(0, colonIdx);
      const seq = parseInt(key.slice(colonIdx + 1), 10);
      const saveEvent = index.bySeq.get(`${sessionId}:${seq}`);
      expect(saveEvent).toBeDefined();

      // Reconstruct up to this save (exclusive) and check content hash.
      const upToRecon = reconstructFile(index, '/test/file.py', saveEvent!.globalIdx);
      const computedHash = sha256Hex(upToRecon.content);
      expect(computedHash).toBe(recordedHash);
    }
  });
});

// ---------------------------------------------------------------------------
// reconstructFile — recorder v1.1 doc.open content seeding
// ---------------------------------------------------------------------------

describe('reconstructFile — doc.open content seeding (recorder v1.1)', () => {
  it('seeds content from doc.open payload and applies subsequent delta correctly', async () => {
    // Reproduces the real-world bug: hw.py has '# placeholder\n' as pre-existing
    // content; the first recorded delta inserts 'h' at line 1, char 0.
    //
    // OLD behaviour (no content in doc.open):
    //   content starts as '' → delta clamps to offset 0 → result: 'h'
    //
    // NEW behaviour (recorder v1.1, content seeded):
    //   content starts as '# placeholder\n' → delta at L1C0 = offset 15
    //   → result: '# placeholder\nh'
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
    const recon = reconstructFile(index, 'hw.py');

    expect(recon.content).toBe('# placeholder\nh');
    expect(recon.tainted).toBe(false);
  });

  it('without doc.open content (pre-v1.1 behaviour), delta at L1C0 clamps to empty string', async () => {
    // Control case: no content field in doc.open → starts from ''.
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
                // No content field — pre-v1.1 recorder behaviour.
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
    const recon = reconstructFile(index, 'hw.py');

    // Without initial content, L1C0 in an empty string clamps to offset 0.
    expect(recon.content).toBe('h');
    expect(recon.tainted).toBe(false);
  });

  it('save hash matches after seeding from doc.open content', async () => {
    // Verify that the recorded doc.save hash matches the reconstructed content
    // when reconstruction is seeded from doc.open content.
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
    const recon = reconstructFile(index, 'hw.py');

    expect(recon.tainted).toBe(false);
    expect(recon.content).toBe(finalContent);
    expect(recon.hashBySaveSeq.size).toBe(1);
    const recordedHash = [...recon.hashBySaveSeq.values()][0]!;
    expect(sha256Hex(recon.content)).toBe(recordedHash);
    expect(recordedHash).toBe(saveHash);
  });
});

// ---------------------------------------------------------------------------
// D1c: disk content that the student's own edits produce.
//
// D1 and D1b both anchor on `doc.save.sha256` — a field the recorder derives
// from the same racy disk read the rules exist to compensate for. When that
// hash is itself stale, no save-anchored rule can match, however the window is
// tuned, and the bogus event survives.
//
// D1c drops the save entirely and compares against reconstruction: if the
// "external" content is byte-identical to what replaying the student's own
// editor events produces, nothing outside the editor wrote that file.
//
// Measured on a term-1 submission: D1+D1b suppressed 167 of 189; adding D1c
// suppressed 188 of 189.
// ---------------------------------------------------------------------------

describe('reconstructFile — self-inflicted fs.external_change, edit-derived (D1c)', () => {
  it('does not taint when new_hash is the content the edits themselves produce', async () => {
    // No doc.save anywhere in the stream, so neither D1 nor D1b can fire. The
    // only thing identifying this event is that disk held exactly what the
    // student had typed.
    const { zipBuffer } = await buildTestBundle({
      sessions: [
        {
          events: [
            {
              kind: 'doc.change',
              wall: '2026-01-01T00:05:00.000Z',
              data: {
                path: '/src/app.py',
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
              kind: 'fs.external_change',
              wall: '2026-01-01T00:05:01.000Z',
              data: {
                path: '/src/app.py',
                old_hash: 'stale-model-hash',
                new_hash: sha256Hex('hello'),
                diff_size: 1,
                operation: 'modify',
              },
            },
            {
              kind: 'doc.change',
              wall: '2026-01-01T00:05:02.000Z',
              data: {
                path: '/src/app.py',
                deltas: [
                  {
                    range: { start: { line: 0, character: 5 }, end: { line: 0, character: 5 } },
                    text: ' world',
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
    const recon = reconstructFile(index, '/src/app.py');

    expect(recon.tainted).toBe(false);
    expect(recon.taintReasons).toHaveLength(0);
    expect(recon.content).toBe('hello world');
    expect(recon.suppressedExternalChanges).toHaveLength(1);
  });

  it('STILL taints when new_hash is content the edits never produced', async () => {
    // Anti-regression: the rule forgives only bytes the student's own events
    // account for. Foreign content must survive.
    const { zipBuffer } = await buildTestBundle({
      sessions: [
        {
          events: [
            {
              kind: 'doc.change',
              wall: '2026-01-01T00:05:00.000Z',
              data: {
                path: '/src/app.py',
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
              kind: 'fs.external_change',
              wall: '2026-01-01T00:05:01.000Z',
              data: {
                path: '/src/app.py',
                old_hash: sha256Hex('hello'),
                new_hash: sha256Hex('something a tool wrote'),
                diff_size: 4000,
                operation: 'modify',
              },
            },
          ],
        },
      ],
    });

    const bundle = await loadBundleFrom(zipBuffer);
    const index = buildIndex(bundle);
    const recon = reconstructFile(index, '/src/app.py');

    expect(recon.tainted).toBe(true);
    expect(recon.suppressedExternalChanges).toHaveLength(0);
  });

  it('keeps matching after an unexplained event rather than giving up on the file', async () => {
    // Policy: a non-matching event does NOT stop D1c for the rest of the file.
    // A single transient disk state (e.g. the recorder catching a save
    // mid-truncate) would otherwise poison every later comparison. Measured on
    // a term-1 submission: giving up costs 14 of 24 suppressions.
    //
    // Safe because the test is a hash equality against content derived solely
    // from the student's own events — divergence makes a match LESS likely, not
    // more, so this cannot manufacture a suppression.
    const { zipBuffer } = await buildTestBundle({
      sessions: [
        {
          events: [
            {
              kind: 'doc.change',
              wall: '2026-01-01T00:05:00.000Z',
              data: {
                path: '/src/app.py',
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
              // Unexplained: disk momentarily held something else entirely.
              kind: 'fs.external_change',
              wall: '2026-01-01T00:05:01.000Z',
              data: {
                path: '/src/app.py',
                old_hash: sha256Hex('hello'),
                new_hash: sha256Hex(''),
                diff_size: 5,
                operation: 'modify',
              },
            },
            {
              kind: 'doc.change',
              wall: '2026-01-01T00:05:02.000Z',
              data: {
                path: '/src/app.py',
                deltas: [
                  {
                    range: { start: { line: 0, character: 5 }, end: { line: 0, character: 5 } },
                    text: ' world',
                  },
                ],
                source: 'typed',
              },
            },
            {
              // Back to the ordinary race — still recognised.
              kind: 'fs.external_change',
              wall: '2026-01-01T00:05:03.000Z',
              data: {
                path: '/src/app.py',
                old_hash: 'stale-model-hash',
                new_hash: sha256Hex('hello world'),
                diff_size: 1,
                operation: 'modify',
              },
            },
          ],
        },
      ],
    });

    const bundle = await loadBundleFrom(zipBuffer);
    const index = buildIndex(bundle);
    const recon = reconstructFile(index, '/src/app.py');

    // The first survives (real, or at least unexplained); the second does not.
    expect(recon.suppressedExternalChanges).toEqual([
      index.byFile.get('/src/app.py')!.filter((e) => e.kind === 'fs.external_change')[1]!.globalIdx,
    ]);
    expect(recon.tainted).toBe(true);
  });
});
