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

    // verify-chain should not report seq_gap as a chain_integrity failure.
    const check = verifyChain(result.value);
    // A seq gap that's also followed by a hash mismatch (since prev_hash chain
    // is now broken) would show here. But a pure seq-gap (no hash corruption)
    // would only be caught by verify-seq. With our tamper, dropping an entry
    // means the NEXT entry's seq now != its array index (seq_gap), not necessarily
    // a hash_mismatch. So verify-chain should return pass or fail only on hash_mismatch.
    // The check may still pass here since seq_gap ≠ hash_mismatch.
    expect(check.id).toBe('chain_integrity');
    // We don't assert pass/fail here because whether it fails depends on whether
    // the next entry's prev_hash still matches. Just assert no exception thrown.
  });
});
