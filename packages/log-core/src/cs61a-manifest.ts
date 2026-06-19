/**
 * Parser and signature verifier for the .provenance-manifest assignment file.
 * PRD §4.1 — the recorder activates only when this manifest is present and valid.
 *
 * Signing payload: canonicalize({assignment_id, semester, issued_at, files_under_review})
 * (the `sig` field is excluded before canonicalization).
 */

import * as ed from '@noble/ed25519';
import { hexToBytes } from '@noble/hashes/utils.js';
import { canonicalize } from './canonical.js';
import { ok, err } from './result.js';
import type { Result } from './result.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Cs61aManifest = {
  assignment_id: string;
  semester: string;
  /** ISO 8601 timestamp. */
  issued_at: string;
  files_under_review: readonly string[];
  /** Hex ed25519 signature, 128 chars (64 bytes). */
  sig: string;
};

export type ManifestError =
  | { kind: 'invalid_json'; message: string }
  | { kind: 'invalid_shape'; field?: string; reason?: string }
  | { kind: 'invalid_signature' };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HEX_128_RE = /^[0-9a-f]{128}$/;
const HEX_64_RE = /^[0-9a-f]{64}$/;

/**
 * Build the canonical bytes that were signed.
 * The sig field is excluded — only the four payload fields are canonicalized.
 * JCS key ordering means these four fields are serialized in a deterministic order.
 */
function buildSignedPayload(manifest: Omit<Cs61aManifest, 'sig'>): Uint8Array {
  const payload = canonicalize({
    assignment_id: manifest.assignment_id,
    semester: manifest.semester,
    issued_at: manifest.issued_at,
    files_under_review: manifest.files_under_review,
  });
  return new TextEncoder().encode(payload);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a .provenance-manifest file (text content) into a Cs61aManifest.
 * Validates JSON structure and field shapes. Does NOT verify the signature.
 */
export function parseManifest(text: string): Result<Cs61aManifest, ManifestError> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err({ kind: 'invalid_json', message });
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return err({ kind: 'invalid_shape', reason: 'must be an object' });
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj['assignment_id'] !== 'string' || obj['assignment_id'].length === 0) {
    return err({
      kind: 'invalid_shape',
      field: 'assignment_id',
      reason: 'must be a non-empty string',
    });
  }
  if (typeof obj['semester'] !== 'string' || obj['semester'].length === 0) {
    return err({ kind: 'invalid_shape', field: 'semester', reason: 'must be a non-empty string' });
  }
  if (typeof obj['issued_at'] !== 'string' || obj['issued_at'].length === 0) {
    return err({ kind: 'invalid_shape', field: 'issued_at', reason: 'must be a non-empty string' });
  }
  if (!Array.isArray(obj['files_under_review'])) {
    return err({ kind: 'invalid_shape', field: 'files_under_review', reason: 'must be an array' });
  }
  for (const f of obj['files_under_review'] as unknown[]) {
    if (typeof f !== 'string') {
      return err({
        kind: 'invalid_shape',
        field: 'files_under_review',
        reason: 'all elements must be strings',
      });
    }
  }

  // sig: 128 hex chars (64-byte ed25519 signature)
  if (obj['sig'] === undefined) {
    return err({
      kind: 'invalid_shape',
      field: 'sig',
      reason: 'missing',
    });
  }
  if (typeof obj['sig'] !== 'string' || !HEX_128_RE.test(obj['sig'])) {
    return err({
      kind: 'invalid_shape',
      field: 'sig',
      reason: 'must be a 128-char hex string',
    });
  }

  return ok({
    assignment_id: obj['assignment_id'] as string,
    semester: obj['semester'] as string,
    issued_at: obj['issued_at'] as string,
    files_under_review: obj['files_under_review'] as readonly string[],
    sig: obj['sig'] as string,
  });
}

/**
 * Verify the ed25519 signature on a parsed Cs61aManifest.
 *
 * @param manifest  A manifest returned by parseManifest (sig already validated as 128 hex chars).
 * @param pubkey    Hex-encoded ed25519 public key (32 bytes → 64 hex chars).
 *
 * The signed payload is canonicalize({assignment_id, semester, issued_at, files_under_review}).
 * The `sig` field is excluded from the payload (PRD §4.1).
 */
export async function verifyManifest(
  manifest: Cs61aManifest,
  pubkey: string,
): Promise<Result<true, ManifestError>> {
  if (!HEX_64_RE.test(pubkey)) {
    return err({ kind: 'invalid_signature' });
  }

  const sigBytes = hexToBytes(manifest.sig);
  const pubkeyBytes = hexToBytes(pubkey);
  const payloadBytes = buildSignedPayload(manifest);

  let valid: boolean;
  try {
    // `@noble/ed25519` v3 defaults to ZIP215 verification semantics (more permissive than RFC8032
    // about non-canonical point encodings). Safe here since the course public key is hardcoded;
    // reconsider if the key ever becomes user-supplied.
    valid = await ed.verifyAsync(sigBytes, payloadBytes, pubkeyBytes);
  } catch {
    return err({ kind: 'invalid_signature' });
  }

  if (!valid) {
    return err({ kind: 'invalid_signature' });
  }

  return ok(true as const);
}
