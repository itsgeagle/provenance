/**
 * Tests for Check 1 — Bundle manifest signature.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { loadBundle } from '../loader/parse-bundle.js';
import { buildTestBundle } from '../test-support/build-test-bundle.js';
import { verifyManifestSig } from './verify-manifest-sig.js';

// Wire SHA-512 for jsdom compatibility (same pattern as build-test-bundle).
beforeAll(() => {
  ed.hashes.sha512 = sha512;
  (ed.hashes as Record<string, unknown>)['sha512Async'] = (m: Uint8Array) =>
    Promise.resolve(sha512(m));
});

describe('verifyManifestSig', () => {
  it('returns pass for a well-formed bundle with a valid signature', async () => {
    const { blob } = await buildTestBundle();
    const result = await loadBundle(blob, 'test.zip');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const check = await verifyManifestSig(result.value);
    expect(check.id).toBe('manifest_sig');
    expect(check.status).toBe('pass');
    expect(check.detail).toMatch(/Verified against session/);
  });

  it('returns pass for a multi-session bundle (most-recent session pubkey used)', async () => {
    const { blob } = await buildTestBundle({
      sessions: [{ eventCount: 3 }, { eventCount: 3 }],
    });
    const result = await loadBundle(blob, 'test.zip');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const check = await verifyManifestSig(result.value);
    expect(check.status).toBe('pass');
  });

  it('returns fail when manifest.sig is not valid hex', async () => {
    const { blob } = await buildTestBundle();
    const result = await loadBundle(blob, 'test.zip');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Corrupt the sig in the bundle object directly.
    const bundle = {
      ...result.value,
      manifestSigHex: 'not-hex!!!',
    };

    const check = await verifyManifestSig(bundle);
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(/not valid hex/);
  });

  it('returns fail when the signature is valid hex but does not match any session pubkey', async () => {
    const { blob } = await buildTestBundle();
    const result = await loadBundle(blob, 'test.zip');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const bundle = {
      ...result.value,
      // Replace sig with a valid-hex but wrong signature.
      manifestSigHex: 'ab'.repeat(32),
    };

    const check = await verifyManifestSig(bundle);
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(/did not verify/);
  });
});
