/**
 * The ONE hash-chaining function for the Provenance codebase.
 * CLAUDE.md: "exactly one such function and it lives in log-core."
 * PRD §5.2: entry.hash == sha256(prev_hash + canonical_json(entry without "hash"))
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { EventKind } from './events.js';
import type { Envelope, HashedEnvelope } from './envelope.js';
import { canonicalize } from './canonical.js';

/**
 * The genesis entry's prev_hash: sixty-four hex zeros.
 * PRD §5.1 example: `"prev_hash": "0000..."`.
 */
export const GENESIS_PREV_HASH = '0'.repeat(64);

/**
 * A hash function that accepts a string or bytes and returns a lowercase hex string.
 * Callers may inject their own (e.g. a test double), but the default is SHA-256.
 */
export type HashFn = (input: string | Uint8Array) => string;

/**
 * Default SHA-256 implementation via @noble/hashes.
 * Returns a 64-character lowercase hex string.
 */
export const sha256Hex: HashFn = (input: string | Uint8Array): string => {
  const bytes: Uint8Array = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  return bytesToHex(sha256(bytes));
};

/**
 * Chain a single log entry.
 *
 * Algorithm (PRD §5.2):
 *   1. Canonicalize the envelope (no prev_hash / hash fields — it's an Envelope, not HashedEnvelope).
 *   2. Prepend prev_hash (string) to the canonical JSON string.
 *   3. Hash the concatenated string.
 *   4. Return a new object with prev_hash and hash appended.
 *
 * @param prevHash  sha256 hex of the previous entry, or GENESIS_PREV_HASH for seq 0.
 * @param entry     The envelope to chain (must not already have prev_hash / hash).
 * @param hashFn    Hash function; defaults to sha256Hex.
 */
export function chainEntry<K extends EventKind>(
  prevHash: string,
  entry: Envelope<K>,
  hashFn: HashFn = sha256Hex,
): HashedEnvelope<K> {
  const canonical = canonicalize(entry);
  const hash = hashFn(prevHash + canonical);
  return { ...entry, prev_hash: prevHash, hash };
}
