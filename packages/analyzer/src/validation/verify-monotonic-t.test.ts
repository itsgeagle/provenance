/**
 * Tests for Check 5 — Monotonically non-decreasing t.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { loadBundle } from '../loader/parse-bundle.js';
import { buildTestBundle } from '../../test/helpers/build-test-bundle.js';
import { verifyMonotonicT } from './verify-monotonic-t.js';

beforeAll(() => {
  ed.hashes.sha512 = sha512;
  (ed.hashes as Record<string, unknown>)['sha512Async'] = (m: Uint8Array) =>
    Promise.resolve(sha512(m));
});

describe('verifyMonotonicT', () => {
  it('returns pass for a valid bundle', async () => {
    const { blob } = await buildTestBundle({ sessions: [{ eventCount: 5 }] });
    const result = await loadBundle(blob, 'test.zip');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const check = verifyMonotonicT(result.value);
    expect(check.id).toBe('monotonic_t');
    expect(check.status).toBe('pass');
  });

  it('returns fail when a t value regresses', async () => {
    // regressT on entry at index 3 (seq 3): subtract 5000ms → t goes backward.
    // With the direct-walk implementation, verify-monotonic-t finds t regressions
    // independently of hash state.
    const { blob } = await buildTestBundle({
      sessions: [{ eventCount: 5 }],
      tamper: { regressT: { sessionIndex: 0, entryIndex: 3, deltaMs: 5000 } },
    });
    const result = await loadBundle(blob, 'test.zip');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const check = verifyMonotonicT(result.value);
    expect(check.id).toBe('monotonic_t');
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(/t regression/i);
    expect(check.supportingSeqs).toBeDefined();
    expect(check.supportingSeqs![0]?.seq).toBe(3);
  });

  it('collects all t regressions in a session, not just the first', async () => {
    // Regress t at entry index 2 and entry index 4.
    const { blob } = await buildTestBundle({
      sessions: [{ eventCount: 5 }],
      tamper: {
        regressT: [
          { sessionIndex: 0, entryIndex: 2, deltaMs: 3000 },
          { sessionIndex: 0, entryIndex: 4, deltaMs: 5000 },
        ],
      },
    });
    const result = await loadBundle(blob, 'test.zip');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const check = verifyMonotonicT(result.value);
    expect(check.status).toBe('fail');
    expect(check.supportingSeqs).toBeDefined();
    // Both regressions must appear.
    const seqs = check.supportingSeqs!.map((s) => s.seq);
    expect(seqs).toContain(2);
    expect(seqs).toContain(4);
  });
});
