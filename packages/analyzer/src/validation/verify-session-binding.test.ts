/**
 * Tests for Check 2 — Session binding.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { loadBundle } from '../loader/parse-bundle.js';
import { buildTestBundle } from '../../test/helpers/build-test-bundle.js';
import { verifySessionBinding } from './verify-session-binding.js';

beforeAll(() => {
  ed.hashes.sha512 = sha512;
  (ed.hashes as Record<string, unknown>)['sha512Async'] = (m: Uint8Array) =>
    Promise.resolve(sha512(m));
});

describe('verifySessionBinding', () => {
  it('returns pass for a single-session bundle', async () => {
    const { blob } = await buildTestBundle({ sessions: [{}] });
    const result = await loadBundle(blob, 'test.zip');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const check = verifySessionBinding(result.value);
    expect(check.id).toBe('session_binding');
    expect(check.status).toBe('pass');
  });

  it('returns pass for a multi-session bundle where all sessions share the same manifest_sig', async () => {
    const { blob } = await buildTestBundle({
      sessions: [{ eventCount: 3 }, { eventCount: 3 }, { eventCount: 3 }],
    });
    const result = await loadBundle(blob, 'test.zip');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const check = verifySessionBinding(result.value);
    expect(check.status).toBe('pass');
    expect(check.detail).toMatch(/3 sessions share/);
  });

  it('returns fail when one session has a different manifest_sig', async () => {
    const { blob } = await buildTestBundle({
      sessions: [{ eventCount: 3 }, { eventCount: 3 }],
      tamper: {
        mismatchManifestSig: {
          sessionIndex: 1,
          manifest_sig: 'different-sig-from-another-assignment',
        },
      },
    });
    // loadBundle will succeed (this tamper doesn't break structural validity).
    const result = await loadBundle(blob, 'test.zip');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const check = verifySessionBinding(result.value);
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(/different .cs61a manifest/);
    expect(check.supportingSeqs).toHaveLength(1);
    expect(check.supportingSeqs?.[0]?.seq).toBe(0);
  });
});
