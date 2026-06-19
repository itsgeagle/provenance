/**
 * Per-session ephemeral ed25519 keypair generation and private-key encryption.
 *
 * PRD §4.6: "a per-session ephemeral signing keypair (private key encrypted with
 * a key derived from the `.provenance-manifest` manifest's signature — this means it can't be
 * recovered without the manifest, raising the bar for replay attacks)"
 *
 * Implementation decisions:
 * - Keypair: @noble/ed25519 — randomSecretKey() + getPublicKeyAsync().
 * - KDF: HKDF-SHA256, IKM = hex-decoded manifest sig, salt = 16 random bytes,
 *   info = UTF-8 "provenance-session-key-v1", output length = 32 bytes.
 * - Cipher: XChaCha20-Poly1305 via @noble/ciphers/chacha.js, 24-byte random nonce.
 *   The 16-byte auth tag is appended to the ciphertext by the library.
 *   Wrong key/nonce → auth-tag verification failure (throws) on decrypt, which
 *   proves wrong manifestSig fails (the main security property, tested in tests).
 */

import * as ed from '@noble/ed25519';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SessionKeypair = {
  /** Hex-encoded ed25519 public key (32 bytes → 64 hex chars). */
  publicKeyHex: string;
  /** Raw 32-byte ed25519 secret key (kept in memory only; never persisted raw). */
  privateKey: Uint8Array;
};

export type EncryptedPrivkey = {
  algorithm: 'xchacha20-poly1305-hkdf-sha256-v1';
  /** Hex-encoded XChaCha20 nonce (24 bytes → 48 hex chars). */
  nonce: string;
  /** Hex-encoded ciphertext (32 bytes plaintext + 16 bytes auth tag → 96 hex chars). */
  ciphertext: string;
  /** Hex-encoded HKDF salt (16 bytes → 32 hex chars). */
  salt: string;
  /** ASCII info string passed to HKDF. Fixed: 'provenance-session-key-v1'. */
  info: string;
};

// ---------------------------------------------------------------------------
// Keypair generation
// ---------------------------------------------------------------------------

/**
 * Generate a fresh ed25519 keypair for this session.
 * The private key is returned as raw bytes and should only ever live in memory
 * until it is encrypted via encryptSessionPrivkey().
 */
export async function generateSessionKeypair(): Promise<SessionKeypair> {
  const privateKey = ed.utils.randomSecretKey(); // 32 bytes
  const publicKeyBytes = await ed.getPublicKeyAsync(privateKey); // 32 bytes
  return {
    publicKeyHex: bytesToHex(publicKeyBytes),
    privateKey,
  };
}

// ---------------------------------------------------------------------------
// Private key encryption / decryption
// ---------------------------------------------------------------------------

const HKDF_INFO = 'provenance-session-key-v1';

/**
 * Derive the symmetric encryption key from the manifest signature using HKDF-SHA256.
 * IKM = hex-decoded manifestSig bytes; salt = random; info = fixed ASCII.
 */
function deriveKey(manifestSig: string, saltBytes: Uint8Array): Uint8Array {
  const ikm = hexToBytes(manifestSig);
  const info = new TextEncoder().encode(HKDF_INFO);
  return hkdf(sha256, ikm, saltBytes, info, 32);
}

/**
 * Encrypt the private key under a key derived from the manifest signature.
 *
 * The IKM for the KDF is the raw bytes of the manifest sig (hex-decoded).
 * This binds the private key to the specific assignment manifest — decrypting it
 * requires knowledge of the manifest sig, making replay attacks harder (PRD §6).
 */
export async function encryptSessionPrivkey(
  privateKey: Uint8Array,
  manifestSig: string,
  _sessionId: string, // Reserved for future use (PRD §4.6 design note: sessionId available)
): Promise<EncryptedPrivkey> {
  const saltBytes = randomBytes(16);
  const nonceBytes = randomBytes(24);

  const symmetricKey = deriveKey(manifestSig, saltBytes);
  const cipher = xchacha20poly1305(symmetricKey, nonceBytes);
  const ciphertext = cipher.encrypt(privateKey);

  return {
    algorithm: 'xchacha20-poly1305-hkdf-sha256-v1',
    nonce: bytesToHex(nonceBytes),
    ciphertext: bytesToHex(ciphertext),
    salt: bytesToHex(saltBytes),
    info: HKDF_INFO,
  };
}

/**
 * Decrypt the private key. Throws if the manifest sig is wrong (auth tag mismatch).
 */
export async function decryptSessionPrivkey(
  encrypted: EncryptedPrivkey,
  manifestSig: string,
): Promise<Uint8Array> {
  const saltBytes = hexToBytes(encrypted.salt);
  const nonceBytes = hexToBytes(encrypted.nonce);
  const ciphertextBytes = hexToBytes(encrypted.ciphertext);

  const symmetricKey = deriveKey(manifestSig, saltBytes);
  const cipher = xchacha20poly1305(symmetricKey, nonceBytes);
  // xchacha20poly1305.decrypt() throws on auth tag failure — this is the
  // security property that ensures a wrong manifestSig cannot decrypt the key.
  return cipher.decrypt(ciphertextBytes);
}
