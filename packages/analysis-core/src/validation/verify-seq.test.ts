/**
 * Tests for Check 4 — No seq gaps.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { loadBundle } from '../loader/parse-bundle.js';
import { buildTestBundle } from '../test-support/build-test-bundle.js';
import { verifySeq } from './verify-seq.js';

beforeAll(() => {
  ed.hashes.sha512 = sha512;
  (ed.hashes as Record<string, unknown>)['sha512Async'] = (m: Uint8Array) =>
    Promise.resolve(sha512(m));
});

describe('verifySeq', () => {
  it('returns pass for a valid bundle', async () => {
    const { blob } = await buildTestBundle({ sessions: [{ eventCount: 5 }] });
    const result = await loadBundle(blob, 'test.zip');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const check = verifySeq(result.value);
    expect(check.id).toBe('seq_gaps');
    expect(check.status).toBe('pass');
  });

  it('returns fail when an entry is dropped creating a seq gap', async () => {
    // Drop entry at index 2 (seq 2); the next entry has seq 3 but is at array
    // index 2, so validateChain sees seq=3 where expected=2.
    const { blob } = await buildTestBundle({
      sessions: [{ eventCount: 5 }],
      tamper: { addSeqGap: { sessionIndex: 0, afterEntryIndex: 1 } },
    });
    const result = await loadBundle(blob, 'test.zip');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const check = verifySeq(result.value);
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(/seq gap/i);
    expect(check.supportingSeqs).toBeDefined();
    expect(check.supportingSeqs!.length).toBeGreaterThan(0);
    // The gap is at seq 3 (expected 2).
    expect(check.supportingSeqs![0]?.seq).toBe(3);
  });

  it('returns pass for a multi-session bundle with no gaps', async () => {
    const { blob } = await buildTestBundle({
      sessions: [{ eventCount: 4 }, { eventCount: 4 }],
    });
    const result = await loadBundle(blob, 'test.zip');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const check = verifySeq(result.value);
    expect(check.status).toBe('pass');
  });

  it('collects all seq gaps across sessions', async () => {
    // Two sessions, each with one gap. Both gaps should be reported.
    const { blob } = await buildTestBundle({
      sessions: [{ eventCount: 3 }, { eventCount: 3 }],
      tamper: {
        addSeqGap: [
          { sessionIndex: 0, afterEntryIndex: 1 },
          { sessionIndex: 1, afterEntryIndex: 1 },
        ],
      },
    });
    const result = await loadBundle(blob, 'test.zip');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const check = verifySeq(result.value);
    expect(check.status).toBe('fail');
    expect(check.supportingSeqs).toBeDefined();
    // One gap per session → 2 failures total.
    expect(check.supportingSeqs!.length).toBe(2);
    // Each failure is in a different session.
    const sessionIds = new Set(check.supportingSeqs!.map((s) => s.sessionId));
    expect(sessionIds.size).toBe(2);
  });

  it('reports one failure (not N) for a single gap that misaligns all subsequent entries', async () => {
    // Drop one entry: all following entries shift seq vs. index. Only 1 gap recorded.
    const { blob } = await buildTestBundle({
      sessions: [{ eventCount: 5 }],
      tamper: { addSeqGap: { sessionIndex: 0, afterEntryIndex: 1 } },
    });
    const result = await loadBundle(blob, 'test.zip');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const check = verifySeq(result.value);
    expect(check.status).toBe('fail');
    expect(check.supportingSeqs).toBeDefined();
    // One gap, not 4 cascade reports.
    expect(check.supportingSeqs!.length).toBe(1);
  });
});
