/**
 * Tests for Check 3 — Hash chain integrity.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { loadBundle } from '../loader/parse-bundle.js';
import { buildTestBundle } from '../../test/helpers/build-test-bundle.js';
import { verifyChain } from './verify-chain.js';

beforeAll(() => {
  ed.hashes.sha512 = sha512;
  (ed.hashes as Record<string, unknown>)['sha512Async'] = (m: Uint8Array) =>
    Promise.resolve(sha512(m));
});

describe('verifyChain', () => {
  it('returns pass for a valid bundle', async () => {
    const { blob } = await buildTestBundle({ sessions: [{ eventCount: 5 }] });
    const result = await loadBundle(blob, 'test.zip');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const check = verifyChain(result.value);
    expect(check.id).toBe('chain_integrity');
    expect(check.status).toBe('pass');
  });

  it('returns fail when an entry hash is corrupted', async () => {
    const { blob } = await buildTestBundle({
      sessions: [{ eventCount: 5 }],
      tamper: { breakChainAt: { sessionIndex: 0, entryIndex: 3 } },
    });
    // The loader's parse-bundle does NOT validate the chain — it just parses.
    // So loadBundle should succeed even with a corrupted hash.
    const result = await loadBundle(blob, 'test.zip');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const check = verifyChain(result.value);
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(/hash mismatch/);
    expect(check.supportingSeqs).toBeDefined();
    expect(check.supportingSeqs!.length).toBeGreaterThan(0);
  });

  it('does not surface seq_gap failures (those belong to verify-seq)', async () => {
    const { blob } = await buildTestBundle({
      sessions: [{ eventCount: 5 }],
      tamper: { addSeqGap: { sessionIndex: 0, afterEntryIndex: 2 } },
    });
    const result = await loadBundle(blob, 'test.zip');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // A pure seq-gap (dropping an entry so the next entry's seq is off by one)
    // does NOT change any entry's hash — the remaining entries still have valid
    // hash values relative to their own content and their predecessor's hash.
    // verify-chain must return pass for this case.
    const check = verifyChain(result.value);
    expect(check.id).toBe('chain_integrity');
    expect(check.status).toBe('pass');
  });

  it('collects all hash mismatches in a session, not just the first', async () => {
    // Break the chain at two separate entries (index 1 and index 4).
    const { blob } = await buildTestBundle({
      sessions: [{ eventCount: 5 }],
      tamper: {
        breakChainAt: [
          { sessionIndex: 0, entryIndex: 1 },
          { sessionIndex: 0, entryIndex: 4 },
        ],
      },
    });
    const result = await loadBundle(blob, 'test.zip');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const check = verifyChain(result.value);
    expect(check.status).toBe('fail');
    expect(check.supportingSeqs).toBeDefined();
    // Both broken entries must appear in the results.
    const seqs = check.supportingSeqs!.map((s) => s.seq);
    expect(seqs).toContain(1);
    expect(seqs).toContain(4);
    expect(seqs.length).toBeGreaterThanOrEqual(2);
  });
});
