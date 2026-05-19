/**
 * Chain validator for HashedEnvelope sequences.
 * Implements PRD §5.4 steps 3–6.
 */

import type { HashedEnvelope } from './envelope.js';
import type { HashFn } from './hash-chain.js';
import { GENESIS_PREV_HASH, sha256Hex } from './hash-chain.js';
import { canonicalize } from './canonical.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ChainBreak =
  | { reason: 'hash_mismatch'; at_seq: number }
  | { reason: 'seq_gap'; at_seq: number; expected: number }
  | { reason: 't_regression'; at_seq: number }
  | { reason: 'wall_regression'; at_seq: number };

export type ValidationResult = { ok: true } | { ok: false; break: ChainBreak };

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Recompute the expected hash for a HashedEnvelope.
 * Strips prev_hash and hash, canonicalizes the rest, then prepends prev_hash.
 */
function recomputeHash(entry: HashedEnvelope, hashFn: HashFn): string {
  // Build the envelope without the hash fields — matching what chainEntry canonicalizes.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { prev_hash, hash: _hash, ...envelope } = entry;
  const canonical = canonicalize(envelope);
  return hashFn(prev_hash + canonical);
}

/**
 * Returns true if any entry in entries[windowStart .. windowEnd] (inclusive) has
 * kind === 'clock.skew'.
 */
function hasClockSkewInWindow(
  entries: readonly HashedEnvelope[],
  windowStart: number,
  windowEnd: number,
): boolean {
  for (let k = windowStart; k <= windowEnd; k++) {
    if (entries[k]?.kind === 'clock.skew') {
      return true;
    }
  }
  return false;
}

/**
 * Validate a sequence of HashedEnvelopes.
 *
 * Rules (PRD §5.4 steps 3–6):
 *  - seq starts at 0 and increments by 1; gaps → seq_gap.
 *  - Each entry's prev_hash must equal the previous entry's hash (or GENESIS_PREV_HASH for seq 0).
 *  - Each entry's hash must equal sha256(prev_hash + canonicalize(entry without prev_hash/hash)).
 *  - t must be non-decreasing; regression → t_regression.
 *  - wall must be non-decreasing UNLESS a clock.skew event appears between the prior entry and
 *    the current entry (inclusive of current, exclusive of prior) → wall_regression otherwise.
 *
 * An empty array is { ok: true }.
 */
export function validateChain(
  entries: readonly HashedEnvelope[],
  hashFn: HashFn = sha256Hex,
): ValidationResult {
  if (entries.length === 0) {
    return { ok: true };
  }

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    // Satisfy noUncheckedIndexedAccess — entry is always defined in this range.
    if (entry === undefined) continue;

    // -----------------------------------------------------------------------
    // seq must equal the index (i.e. 0, 1, 2, ...)
    // -----------------------------------------------------------------------
    if (entry.seq !== i) {
      return {
        ok: false,
        break: { reason: 'seq_gap', at_seq: entry.seq, expected: i },
      };
    }

    // -----------------------------------------------------------------------
    // prev_hash linkage
    // -----------------------------------------------------------------------
    const expectedPrevHash = i === 0 ? GENESIS_PREV_HASH : (entries[i - 1]?.hash ?? '');
    if (entry.prev_hash !== expectedPrevHash) {
      return { ok: false, break: { reason: 'hash_mismatch', at_seq: entry.seq } };
    }

    // -----------------------------------------------------------------------
    // Hash integrity
    // -----------------------------------------------------------------------
    const computed = recomputeHash(entry, hashFn);
    if (computed !== entry.hash) {
      return { ok: false, break: { reason: 'hash_mismatch', at_seq: entry.seq } };
    }

    // -----------------------------------------------------------------------
    // Checks that require a predecessor
    // -----------------------------------------------------------------------
    if (i > 0) {
      const prev = entries[i - 1];
      if (prev === undefined) continue;

      // t must be non-decreasing
      if (entry.t < prev.t) {
        return { ok: false, break: { reason: 't_regression', at_seq: entry.seq } };
      }

      // wall must be non-decreasing modulo clock.skew events.
      // The skew window is entries[prev.seq .. entry.seq] inclusive.
      // Including the previous entry means: if the clock.skew is the immediately
      // preceding event, the regression it caused is still excused.
      if (entry.wall < prev.wall) {
        const windowStart = prev.seq;
        const windowEnd = entry.seq;
        if (!hasClockSkewInWindow(entries, windowStart, windowEnd)) {
          return { ok: false, break: { reason: 'wall_regression', at_seq: entry.seq } };
        }
      }
    }
  }

  return { ok: true };
}
