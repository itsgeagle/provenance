/**
 * Types and shape-validator for the .slog.meta file.
 * PRD §4.6 — companion file to the session log holding signing metadata.
 *
 * No I/O here — types and validateMetaShape only.
 */

import { ok, err } from './result.js';
import type { Result } from './result.js';

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export type MetaShapeError =
  | { kind: 'not_object' }
  | { kind: 'wrong_version'; actual: unknown }
  | { kind: 'missing_field'; field: string }
  | { kind: 'invalid_field'; field: string; reason: string };

// ---------------------------------------------------------------------------
// Type
// ---------------------------------------------------------------------------

export type SlogMeta = {
  format_version: '1.0';
  session_id: string;
  /** Hex-encoded ed25519 public key (32 bytes → 64 hex chars). */
  session_pubkey: string;
  encrypted_session_privkey: {
    algorithm: 'xchacha20-poly1305-hkdf-sha256-v1';
    /** Hex-encoded nonce. */
    nonce: string;
    /** Hex-encoded ciphertext. */
    ciphertext: string;
    /** Hex-encoded HKDF salt. */
    salt: string;
    /** ASCII info string passed to HKDF. */
    info: string;
  };
  checkpoints: ReadonlyArray<{
    seq: number;
    /** Hex sha256 of entry at this seq (same value as that entry's `hash`). */
    hash: string;
    /** Hex ed25519 signature over canonicalize({seq, hash}) using session_privkey. */
    sig: string;
  }>;
};

// ---------------------------------------------------------------------------
// Regex helpers
// ---------------------------------------------------------------------------

const HEX_RE = /^[0-9a-f]+$/;
const HEX_64_RE = /^[0-9a-f]{64}$/;
const HEX_128_RE = /^[0-9a-f]{128}$/;

function isNonEmptyHex(s: unknown): boolean {
  return typeof s === 'string' && s.length > 0 && HEX_RE.test(s);
}

// ---------------------------------------------------------------------------
// Shape validator
// ---------------------------------------------------------------------------

/**
 * Validate that an unknown value has the SlogMeta shape.
 * Does not verify crypto (signatures, ciphertext integrity, etc.).
 */
export function validateMetaShape(value: unknown): Result<SlogMeta, MetaShapeError> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return err({ kind: 'not_object' });
  }

  const obj = value as Record<string, unknown>;

  // format_version
  if (obj['format_version'] !== '1.0') {
    return err({ kind: 'wrong_version', actual: obj['format_version'] });
  }

  // session_id
  if (typeof obj['session_id'] !== 'string' || obj['session_id'].length === 0) {
    return err({ kind: 'missing_field', field: 'session_id' });
  }

  // session_pubkey: 64 hex chars (32 bytes)
  if (!HEX_64_RE.test(obj['session_pubkey'] as string)) {
    if (obj['session_pubkey'] === undefined) {
      return err({ kind: 'missing_field', field: 'session_pubkey' });
    }
    return err({
      kind: 'invalid_field',
      field: 'session_pubkey',
      reason: 'must be 64 lowercase hex chars (32 bytes)',
    });
  }

  // encrypted_session_privkey
  const esp = obj['encrypted_session_privkey'];
  if (typeof esp !== 'object' || esp === null || Array.isArray(esp)) {
    if (esp === undefined) {
      return err({ kind: 'missing_field', field: 'encrypted_session_privkey' });
    }
    return err({
      kind: 'invalid_field',
      field: 'encrypted_session_privkey',
      reason: 'must be an object',
    });
  }

  const espObj = esp as Record<string, unknown>;

  if (espObj['algorithm'] !== 'xchacha20-poly1305-hkdf-sha256-v1') {
    if (espObj['algorithm'] === undefined) {
      return err({ kind: 'missing_field', field: 'encrypted_session_privkey.algorithm' });
    }
    return err({
      kind: 'invalid_field',
      field: 'encrypted_session_privkey.algorithm',
      reason: 'must be "xchacha20-poly1305-hkdf-sha256-v1"',
    });
  }

  for (const hexField of ['nonce', 'ciphertext', 'salt'] as const) {
    if (!isNonEmptyHex(espObj[hexField])) {
      if (espObj[hexField] === undefined) {
        return err({ kind: 'missing_field', field: `encrypted_session_privkey.${hexField}` });
      }
      return err({
        kind: 'invalid_field',
        field: `encrypted_session_privkey.${hexField}`,
        reason: 'must be a non-empty lowercase hex string',
      });
    }
  }

  if (typeof espObj['info'] !== 'string' || espObj['info'].length === 0) {
    if (espObj['info'] === undefined) {
      return err({ kind: 'missing_field', field: 'encrypted_session_privkey.info' });
    }
    return err({
      kind: 'invalid_field',
      field: 'encrypted_session_privkey.info',
      reason: 'must be a non-empty string',
    });
  }

  // checkpoints: array
  if (!Array.isArray(obj['checkpoints'])) {
    if (obj['checkpoints'] === undefined) {
      return err({ kind: 'missing_field', field: 'checkpoints' });
    }
    return err({ kind: 'invalid_field', field: 'checkpoints', reason: 'must be an array' });
  }

  for (let i = 0; i < obj['checkpoints'].length; i++) {
    const cp = (obj['checkpoints'] as unknown[])[i];
    if (typeof cp !== 'object' || cp === null) {
      return err({
        kind: 'invalid_field',
        field: `checkpoints[${i}]`,
        reason: 'must be an object',
      });
    }
    const cpObj = cp as Record<string, unknown>;

    if (typeof cpObj['seq'] !== 'number') {
      return err({
        kind: 'invalid_field',
        field: `checkpoints[${i}].seq`,
        reason: 'must be a number',
      });
    }
    if (!HEX_64_RE.test(cpObj['hash'] as string)) {
      return err({
        kind: 'invalid_field',
        field: `checkpoints[${i}].hash`,
        reason: 'must be 64 hex chars',
      });
    }
    if (!HEX_128_RE.test(cpObj['sig'] as string)) {
      return err({
        kind: 'invalid_field',
        field: `checkpoints[${i}].sig`,
        reason: 'must be 128 hex chars (64 bytes)',
      });
    }
  }

  return ok(value as SlogMeta);
}
