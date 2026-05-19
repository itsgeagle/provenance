/**
 * Tests for checkpoint signing and verification.
 *
 * Key properties tested:
 * 1. Sign + verify round-trip succeeds.
 * 2. Verify with wrong public key fails.
 * 3. Verify with tampered seq fails.
 * 4. Verify with tampered hash fails.
 * 5. Checkpoint structure is correct.
 */

import { describe, it, expect } from 'vitest';
import * as ed from '@noble/ed25519';
import { bytesToHex } from '@noble/hashes/utils.js';
import { signCheckpoint, verifyCheckpoint } from './checkpoint-signer.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeKeypair(): Promise<{ privateKey: Uint8Array; publicKeyHex: string }> {
  const privateKey = ed.utils.randomSecretKey();
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  return { privateKey, publicKeyHex: bytesToHex(publicKey) };
}

const FAKE_HASH = 'a'.repeat(64); // 64-char hex sha256

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('signCheckpoint', () => {
  it('returns a checkpoint with the correct seq and hash', async () => {
    const { privateKey } = await makeKeypair();
    const cp = await signCheckpoint(99, FAKE_HASH, privateKey);
    expect(cp.seq).toBe(99);
    expect(cp.hash).toBe(FAKE_HASH);
  });

  it('sig is a 128-char hex string (64 bytes)', async () => {
    const { privateKey } = await makeKeypair();
    const cp = await signCheckpoint(0, FAKE_HASH, privateKey);
    expect(cp.sig).toMatch(/^[0-9a-f]{128}$/);
  });
});

describe('verifyCheckpoint', () => {
  it('round-trip: sign + verify with matching public key returns true', async () => {
    const { privateKey, publicKeyHex } = await makeKeypair();
    const cp = await signCheckpoint(42, FAKE_HASH, privateKey);
    const valid = await verifyCheckpoint(cp, publicKeyHex);
    expect(valid).toBe(true);
  });

  it('verify with wrong public key returns false', async () => {
    const { privateKey } = await makeKeypair();
    const { publicKeyHex: wrongPubkey } = await makeKeypair();
    const cp = await signCheckpoint(42, FAKE_HASH, privateKey);
    const valid = await verifyCheckpoint(cp, wrongPubkey);
    expect(valid).toBe(false);
  });

  it('verify with tampered seq returns false', async () => {
    const { privateKey, publicKeyHex } = await makeKeypair();
    const cp = await signCheckpoint(42, FAKE_HASH, privateKey);
    const tampered = { ...cp, seq: 99 }; // seq changed but sig is for seq=42
    const valid = await verifyCheckpoint(tampered, publicKeyHex);
    expect(valid).toBe(false);
  });

  it('verify with tampered hash returns false', async () => {
    const { privateKey, publicKeyHex } = await makeKeypair();
    const cp = await signCheckpoint(42, FAKE_HASH, privateKey);
    const tampered = { ...cp, hash: 'b'.repeat(64) }; // hash changed
    const valid = await verifyCheckpoint(tampered, publicKeyHex);
    expect(valid).toBe(false);
  });

  it('verify with tampered sig returns false', async () => {
    const { privateKey, publicKeyHex } = await makeKeypair();
    const cp = await signCheckpoint(42, FAKE_HASH, privateKey);
    // Flip one hex digit in the sig
    const flipped = cp.sig[0] === 'a' ? '0' : 'a';
    const tampered = { ...cp, sig: flipped + cp.sig.slice(1) };
    const valid = await verifyCheckpoint(tampered, publicKeyHex);
    expect(valid).toBe(false);
  });

  it('different seqs produce different sigs', async () => {
    const { privateKey } = await makeKeypair();
    const cp1 = await signCheckpoint(0, FAKE_HASH, privateKey);
    const cp2 = await signCheckpoint(1, FAKE_HASH, privateKey);
    expect(cp1.sig).not.toBe(cp2.sig);
  });

  it('different hashes produce different sigs', async () => {
    const { privateKey } = await makeKeypair();
    const hash2 = 'b'.repeat(64);
    const cp1 = await signCheckpoint(0, FAKE_HASH, privateKey);
    const cp2 = await signCheckpoint(0, hash2, privateKey);
    expect(cp1.sig).not.toBe(cp2.sig);
  });
});
