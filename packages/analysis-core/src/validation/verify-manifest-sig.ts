/**
 * Check 1 — Bundle manifest signature.
 * PRD §5.4 step 1.
 *
 * The seal command signs the canonicalized manifest.json with the active
 * session's ed25519 private key. We verify against the session_pubkey stored
 * in each session.start.data, trying the most-recently-started session first
 * and falling back to all others.
 *
 * "Most recent" = last entry in bundle.sessions (sorted oldest→newest by the
 * loader).
 */

import * as ed from '@noble/ed25519';
import { canonicalize } from '@provenance/log-core';
import type { Bundle } from '../loader/types.js';
import type { ValidationCheck } from './check-types.js';

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Decode a hex string to Uint8Array.
 * Returns null if the input is not valid hex.
 */
function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    const byte = parseInt(hex.slice(i, i + 2), 16);
    if (isNaN(byte)) return null;
    bytes[i / 2] = byte;
  }
  return bytes;
}

export async function verifyManifestSig(bundle: Bundle): Promise<ValidationCheck> {
  const sigBytes = hexToBytes(bundle.manifestSigHex);
  if (sigBytes === null) {
    return {
      id: 'manifest_sig',
      label: 'Bundle manifest signature',
      status: 'fail',
      detail: `manifest.sig is not valid hex (length ${bundle.manifestSigHex.length}).`,
    };
  }

  const canonicalManifest = canonicalize(bundle.manifest);
  const messageBytes = new TextEncoder().encode(canonicalManifest);

  // Try most-recent session first, then fall back to others.
  const orderedSessions = [...bundle.sessions].reverse();

  for (const session of orderedSessions) {
    const pubkeyHex = session.firstEvent.data.session_pubkey;
    const pubkeyBytes = hexToBytes(pubkeyHex);
    if (pubkeyBytes === null) continue;

    try {
      const valid = await ed.verifyAsync(sigBytes, messageBytes, pubkeyBytes);
      if (valid) {
        return {
          id: 'manifest_sig',
          label: 'Bundle manifest signature',
          status: 'pass',
          detail: `Verified against session ${session.sessionId}.`,
        };
      }
    } catch {
      // verifyAsync throws on malformed keys/sigs; treat as non-match and continue.
    }
  }

  const sessionIds = bundle.sessions.map((s) => s.sessionId).join(', ');
  return {
    id: 'manifest_sig',
    label: 'Bundle manifest signature',
    status: 'fail',
    detail: `Signature did not verify against any session pubkey. Tried sessions: [${sessionIds}].`,
  };
}
