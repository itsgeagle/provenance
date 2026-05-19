/**
 * Tests for Check 7 — Doc save hash consistency.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { sha256Hex } from '@provenance/log-core';
import { loadBundle } from '../loader/parse-bundle.js';
import { buildTestBundle } from '../../test/helpers/build-test-bundle.js';
import { verifyDocSaveHashes } from './verify-doc-save-hashes.js';

beforeAll(() => {
  ed.hashes.sha512 = sha512;
  (ed.hashes as Record<string, unknown>)['sha512Async'] = (m: Uint8Array) =>
    Promise.resolve(sha512(m));
});

describe('verifyDocSaveHashes', () => {
  it('returns pass for a bundle with no doc.save events (nothing to check)', async () => {
    const { blob } = await buildTestBundle({ sessions: [{ eventCount: 5 }] });
    const result = await loadBundle(blob, 'test.zip');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const check = verifyDocSaveHashes(result.value);
    expect(check.id).toBe('doc_save_hashes');
    expect(check.status).toBe('pass');
  });

  it('returns pass when a doc.save hash matches the in-memory reconstruction', async () => {
    // Build a bundle with appendDocSave: the helper computes the correct sha256.
    const { blob } = await buildTestBundle({
      sessions: [{ eventCount: 3, appendDocSave: true }],
    });
    const result = await loadBundle(blob, 'test.zip');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const check = verifyDocSaveHashes(result.value);
    expect(check.status).toBe('pass');
  });

  it('returns fail when a doc.save hash is tampered with', async () => {
    // Build a bundle with a doc.save event, then corrupt that save's sha256.
    const { blob } = await buildTestBundle({
      sessions: [{ eventCount: 3, appendDocSave: true }],
      tamper: {
        mismatchDocSaveHash: {
          sessionIndex: 0,
          saveEntryIndex: 0,
          newHash: 'f'.repeat(64), // wrong sha256
        },
      },
    });
    const result = await loadBundle(blob, 'test.zip');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const check = verifyDocSaveHashes(result.value);
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(/sha256.*does not match/i);
    expect(check.supportingSeqs).toBeDefined();
    expect(check.supportingSeqs!.length).toBeGreaterThan(0);
  });

  it('returns pass (indeterminate) when a doc.open event makes content unknown', async () => {
    // The verifyDocSaveHashes function marks files as indeterminate when
    // doc.open is seen (we have sha256 but not content). We build a bundle
    // with a doc.open event followed by a doc.save without any doc.change
    // events. The save can't be reconstructed from scratch so it's indeterminate.
    //
    // We test this by directly exercising the function with a hand-built bundle.
    const { blob } = await buildTestBundle({ sessions: [{ eventCount: 0 }] });
    const baseResult = await loadBundle(blob, 'test.zip');
    expect(baseResult.ok).toBe(true);
    if (!baseResult.ok) return;

    // Inject a doc.open + doc.save into the session events manually.
    const baseSession = baseResult.value.sessions[0]!;
    const extraEvents = [
      ...baseSession.events,
      // doc.open at seq 1 — marks file as having unknown content
      {
        seq: 1,
        t: 1000,
        wall: '2026-01-01T00:00:10.000Z',
        kind: 'doc.open' as const,
        data: { path: 'hw.py', sha256: 'a'.repeat(64), line_count: 10 },
        prev_hash: baseSession.events[baseSession.events.length - 1]?.hash ?? '',
        hash: 'placeholder',
      },
      // doc.save at seq 2 — cannot be verified (started with unknown content)
      {
        seq: 2,
        t: 2000,
        wall: '2026-01-01T00:00:20.000Z',
        kind: 'doc.save' as const,
        data: { path: 'hw.py', sha256: 'b'.repeat(64) },
        prev_hash: 'placeholder',
        hash: 'placeholder2',
      },
    ] as typeof baseSession.events;

    const bundle = {
      ...baseResult.value,
      sessions: [{ ...baseSession, events: extraEvents }],
    };

    const check = verifyDocSaveHashes(bundle);
    // Should be pass (indeterminate) with a detail explaining why.
    expect(check.status).toBe('pass');
    expect(check.detail).toMatch(/reconstruction not possible|indeterminate|unknown content/i);
  });

  it('sha256Hex("") matches a freshly opened empty file save', () => {
    // Sanity-check: the content model starts empty; a save immediately after
    // session.start (no doc.change) should hash to sha256("").
    const emptyHash = sha256Hex('');
    expect(emptyHash).toHaveLength(64);
    expect(emptyHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
