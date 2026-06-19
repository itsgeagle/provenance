/**
 * Tests for session keypair generation and private-key encryption/decryption.
 *
 * Key properties tested:
 * 1. generateSessionKeypair returns correct sizes.
 * 2. encrypt → decrypt round-trip recovers the original private key.
 * 3. Wrong manifestSig causes auth-tag failure on decrypt.
 * 4. EncryptedPrivkey has the expected algorithm field and non-empty hex fields.
 */

import { describe, it, expect } from 'vitest';
import {
  generateSessionKeypair,
  encryptSessionPrivkey,
  decryptSessionPrivkey,
} from './session-keys.js';

// Minimal valid manifest sig (128 hex chars = 64 bytes = ed25519 sig size)
const FAKE_MANIFEST_SIG = 'ab'.repeat(64); // 128 hex chars
const FAKE_SESSION_ID = '00000000-0000-0000-0000-000000000001';

describe('generateSessionKeypair', () => {
  it('returns a 64-char hex public key', async () => {
    const kp = await generateSessionKeypair();
    expect(kp.publicKeyHex).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns a 32-byte private key', async () => {
    const kp = await generateSessionKeypair();
    expect(kp.privateKey).toBeInstanceOf(Uint8Array);
    expect(kp.privateKey.byteLength).toBe(32);
  });

  it('generates distinct keypairs on successive calls', async () => {
    const kp1 = await generateSessionKeypair();
    const kp2 = await generateSessionKeypair();
    expect(kp1.publicKeyHex).not.toBe(kp2.publicKeyHex);
  });
});

describe('encryptSessionPrivkey', () => {
  it('returns an EncryptedPrivkey with the correct algorithm', async () => {
    const kp = await generateSessionKeypair();
    const enc = await encryptSessionPrivkey(kp.privateKey, FAKE_MANIFEST_SIG, FAKE_SESSION_ID);
    expect(enc.algorithm).toBe('xchacha20-poly1305-hkdf-sha256-v1');
  });

  it('nonce is a non-empty hex string (48 chars = 24 bytes)', async () => {
    const kp = await generateSessionKeypair();
    const enc = await encryptSessionPrivkey(kp.privateKey, FAKE_MANIFEST_SIG, FAKE_SESSION_ID);
    expect(enc.nonce).toMatch(/^[0-9a-f]{48}$/);
  });

  it('salt is a non-empty hex string (32 chars = 16 bytes)', async () => {
    const kp = await generateSessionKeypair();
    const enc = await encryptSessionPrivkey(kp.privateKey, FAKE_MANIFEST_SIG, FAKE_SESSION_ID);
    expect(enc.salt).toMatch(/^[0-9a-f]{32}$/);
  });

  it('ciphertext is a non-empty hex string (96 chars = 32 bytes plaintext + 16 auth tag)', async () => {
    const kp = await generateSessionKeypair();
    const enc = await encryptSessionPrivkey(kp.privateKey, FAKE_MANIFEST_SIG, FAKE_SESSION_ID);
    // 32 bytes plaintext + 16 bytes Poly1305 auth tag = 48 bytes = 96 hex chars
    expect(enc.ciphertext).toMatch(/^[0-9a-f]{96}$/);
  });

  it('info is the expected ASCII string', async () => {
    const kp = await generateSessionKeypair();
    const enc = await encryptSessionPrivkey(kp.privateKey, FAKE_MANIFEST_SIG, FAKE_SESSION_ID);
    expect(enc.info).toBe('provenance-session-key-v1');
  });
});

describe('encryptSessionPrivkey + decryptSessionPrivkey round-trip', () => {
  it('decrypt with correct manifest sig recovers the original private key', async () => {
    const kp = await generateSessionKeypair();
    const enc = await encryptSessionPrivkey(kp.privateKey, FAKE_MANIFEST_SIG, FAKE_SESSION_ID);
    const recovered = await decryptSessionPrivkey(enc, FAKE_MANIFEST_SIG);

    expect(recovered).toBeInstanceOf(Uint8Array);
    expect(recovered.byteLength).toBe(32);
    expect(Buffer.from(recovered).toString('hex')).toBe(Buffer.from(kp.privateKey).toString('hex'));
  });

  it('decrypt with wrong manifest sig throws (auth tag failure)', async () => {
    const kp = await generateSessionKeypair();
    const enc = await encryptSessionPrivkey(kp.privateKey, FAKE_MANIFEST_SIG, FAKE_SESSION_ID);

    const wrongSig = 'cd'.repeat(64); // Different sig
    await expect(decryptSessionPrivkey(enc, wrongSig)).rejects.toThrow();
  });

  it('different manifest sigs produce different encrypted outputs', async () => {
    const kp = await generateSessionKeypair();
    const sig1 = 'ab'.repeat(64);
    const sig2 = 'cd'.repeat(64);

    const enc1 = await encryptSessionPrivkey(kp.privateKey, sig1, FAKE_SESSION_ID);
    const enc2 = await encryptSessionPrivkey(kp.privateKey, sig2, FAKE_SESSION_ID);

    // Same plaintext but different keys → different ciphertexts
    expect(enc1.ciphertext).not.toBe(enc2.ciphertext);
  });
});
