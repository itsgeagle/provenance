/**
 * Check 3 — Hash chain integrity.
 * PRD §5.4 step 3.
 *
 * Walks each session's events directly and recomputes the expected hash for
 * each entry. Reports every entry whose own hash is incorrect given its own
 * content (i.e. sha256(prev_hash + canonical(entry without hash)) ≠ entry.hash).
 *
 * We do NOT cascade-report entries whose prev_hash points at a corrupted
 * predecessor — only entries where the entry itself is broken. seq_gap,
 * t_regression, and wall_regression are surfaced by checks 4–6.
 */

import { sha256Hex, canonicalize } from '@provenance/log-core';
import type { HashedEnvelope } from '@provenance/log-core';
import type { Bundle } from '../loader/types.js';
import type { ValidationCheck } from './check-types.js';

/**
 * Recompute the expected hash for a HashedEnvelope entry given a prevHash.
 * Strips prev_hash and hash, canonicalizes the rest, prepends prevHash.
 */
function recomputeHash(prevHash: string, entry: HashedEnvelope): string {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { prev_hash, hash: _hash, ...envelope } = entry;
  return sha256Hex(prevHash + canonicalize(envelope));
}

export function verifyChain(bundle: Bundle): ValidationCheck {
  const failures: Array<{ sessionId: string; seq: number }> = [];

  for (const session of bundle.sessions) {
    for (const entry of session.events) {
      // Rule: an entry is "broken" iff
      //   sha256(entry.prev_hash + canonical(entry without hash)) ≠ entry.hash.
      //
      // We use entry.prev_hash (not a tracked chain value) so that entries after
      // a seq gap are not cascade-reported: a seq gap does not change any entry's
      // hash fields, so these entries still self-verify correctly against their
      // own prev_hash. Only an entry whose hash field was tampered will fail.
      const expectedHash = recomputeHash(entry.prev_hash, entry);

      if (expectedHash !== entry.hash) {
        failures.push({ sessionId: session.sessionId, seq: entry.seq });
      }
    }
  }

  if (failures.length > 0) {
    return {
      id: 'chain_integrity',
      label: 'Hash chain integrity',
      status: 'fail',
      detail: `${failures.length} hash mismatch(es) detected. The log may have been tampered with.`,
      supportingSeqs: failures,
    };
  }

  return {
    id: 'chain_integrity',
    label: 'Hash chain integrity',
    status: 'pass',
  };
}
