/**
 * Tests for reconstruct-file.ts (Phase 3).
 */

import { describe, it, expect } from 'vitest';
import { reconstructFile, applyDocChange, applyPaste } from './reconstruct-file.js';
import { buildIndex } from './build-index.js';
import { loadBundle } from '../loader/parse-bundle.js';
import type { Bundle } from '../loader/types.js';
import { buildTestBundle } from '../../test/helpers/build-test-bundle.js';
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
    // Content is reset to '' on taint; subsequent changes are not applied.
    expect(recon.content).toBe('');
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
    expect(recon.content).toBe('');
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
