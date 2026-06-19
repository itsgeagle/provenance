/**
 * Sign and verify per-checkpoint proofs in the session log.
 *
 * PRD §4.6: "The chain of seq → hash checkpoints, signed every N events."
 *
 * Signed bytes: canonicalize({seq, hash: entryHash}) → UTF-8 → ed25519 sign.
 * Same JCS approach as the manifest (PRD §5.2, implementation-plan §0.1).
 *
 * The sig is 64 bytes (128 hex chars) — ed25519 standard.
 */

import * as ed from '@noble/ed25519';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { canonicalize } from './canonical.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Checkpoint = {
  /** The seq number of the entry being checkpointed. */
  seq: number;
  /** The entry hash at that seq (hex sha256 — same as entry.hash). */
  hash: string;
  /** Hex-encoded ed25519 signature over canonicalize({seq, hash}). */
  sig: string;
};

// ---------------------------------------------------------------------------
// Sign / verify
// ---------------------------------------------------------------------------

/**
 * Produce the canonical bytes that are signed for a checkpoint.
 * Must be identical between sign and verify.
 */
function checkpointBytes(seq: number, entryHash: string): Uint8Array {
  const json = canonicalize({ hash: entryHash, seq });
  return new TextEncoder().encode(json);
}

/**
 * Sign a checkpoint (seq, entryHash) with the session private key.
 */
export async function signCheckpoint(
  seq: number,
  entryHash: string,
  privateKey: Uint8Array,
): Promise<Checkpoint> {
  const bytes = checkpointBytes(seq, entryHash);
  const sigBytes = await ed.signAsync(bytes, privateKey);
  return {
    seq,
    hash: entryHash,
    sig: bytesToHex(sigBytes),
  };
}

/**
 * Verify a checkpoint against the session public key.
 * Returns false (does not throw) for invalid signatures or malformed input.
 */
export async function verifyCheckpoint(
  checkpoint: Checkpoint,
  publicKeyHex: string,
): Promise<boolean> {
  try {
    const bytes = checkpointBytes(checkpoint.seq, checkpoint.hash);
    const sigBytes = hexToBytes(checkpoint.sig);
    const pubKeyBytes = hexToBytes(publicKeyHex);
    return await ed.verifyAsync(sigBytes, bytes, pubKeyBytes);
  } catch {
    return false;
  }
}
