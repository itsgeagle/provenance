/**
 * Sign a BundleManifest (recorder PRD §5.3).
 *
 * The bundle seal and any tooling that produces bundles must sign the manifest
 * byte-identically, so this is the single signing routine: JCS-canonicalize the
 * manifest, then ed25519-sign the UTF-8 bytes of that canonical string. The
 * caller writes `canonicalJson` to `manifest.json` (exactly what was signed) and
 * `signatureHex` to `manifest.sig`.
 *
 * Pure: no I/O, no VS Code / Node APIs. @noble + log-core only.
 */

import * as ed from '@noble/ed25519';
import { bytesToHex } from '@noble/hashes/utils.js';
import { canonicalize } from './canonical.js';
import type { BundleManifest } from './bundle.js';

export type SignedBundleManifest = {
  /** The exact JCS-canonical JSON written to manifest.json (and signed). */
  canonicalJson: string;
  /** Hex ed25519 signature over the canonical JSON bytes (written to manifest.sig). */
  signatureHex: string;
};

/**
 * Canonicalize and ed25519-sign a bundle manifest with the session private key.
 * Returns both the canonical JSON (to persist) and the hex signature.
 */
export async function signBundleManifest(
  manifest: BundleManifest,
  signingPrivkey: Uint8Array,
): Promise<SignedBundleManifest> {
  const canonicalJson = canonicalize(manifest);
  const bytes = new TextEncoder().encode(canonicalJson);
  const sig = await ed.signAsync(bytes, signingPrivkey);
  return { canonicalJson, signatureHex: bytesToHex(sig) };
}
