import { describe, it, expect } from 'vitest';
import * as ed from '@noble/ed25519';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { parseManifest, verifyManifest } from './cs61a-manifest.js';
import { canonicalize } from './canonical.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the signed payload bytes for a manifest (mirrors buildSignedPayload in cs61a-manifest.ts).
 * The sig field is excluded.
 */
function buildPayload(fields: {
  assignment_id: string;
  semester: string;
  issued_at: string;
  files_under_review: readonly string[];
}): Uint8Array {
  const canonical = canonicalize({
    assignment_id: fields.assignment_id,
    semester: fields.semester,
    issued_at: fields.issued_at,
    files_under_review: fields.files_under_review,
  });
  return new TextEncoder().encode(canonical);
}

/**
 * Generate an ed25519 keypair, sign a manifest payload, and return the manifest JSON text
 * along with the public key hex.
 */
async function makeSignedManifest(overrideFields?: {
  assignment_id?: string;
  semester?: string;
  issued_at?: string;
  files_under_review?: string[];
}): Promise<{ text: string; pubkeyHex: string; secretKey: Uint8Array }> {
  const fields = {
    assignment_id: overrideFields?.assignment_id ?? 'hw03',
    semester: overrideFields?.semester ?? 'fa26',
    issued_at: overrideFields?.issued_at ?? '2026-09-15T00:00:00Z',
    files_under_review: overrideFields?.files_under_review ?? ['hw03.py'],
  };

  const secretKey = ed.utils.randomSecretKey();
  const pubkeyBytes = await ed.getPublicKeyAsync(secretKey);
  const pubkeyHex = bytesToHex(pubkeyBytes);

  const payload = buildPayload(fields);
  const sigBytes = await ed.signAsync(payload, secretKey);
  const sigHex = bytesToHex(sigBytes);

  const manifest = { ...fields, sig: sigHex };
  return { text: JSON.stringify(manifest), pubkeyHex, secretKey };
}

// ---------------------------------------------------------------------------
// parseManifest tests
// ---------------------------------------------------------------------------

describe('parseManifest', () => {
  it('parses a valid manifest JSON string', async () => {
    const { text } = await makeSignedManifest();
    const result = parseManifest(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.assignment_id).toBe('hw03');
    expect(result.value.semester).toBe('fa26');
    expect(result.value.issued_at).toBe('2026-09-15T00:00:00Z');
    expect(result.value.files_under_review).toEqual(['hw03.py']);
    expect(result.value.sig).toHaveLength(128);
  });

  it('rejects garbage JSON', () => {
    const result = parseManifest('this is not json');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('invalid_json');
    }
  });

  it('rejects valid JSON that is not an object', () => {
    const result = parseManifest('"just a string"');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('invalid_shape');
    }
  });

  it('rejects missing assignment_id', () => {
    const obj = {
      semester: 'fa26',
      issued_at: '2026-09-15T00:00:00Z',
      files_under_review: ['hw03.py'],
      sig: 'a'.repeat(128),
    };
    const result = parseManifest(JSON.stringify(obj));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('invalid_shape');
    }
  });

  it('rejects missing files_under_review', () => {
    const obj = {
      assignment_id: 'hw03',
      semester: 'fa26',
      issued_at: '2026-09-15T00:00:00Z',
      sig: 'a'.repeat(128),
    };
    const result = parseManifest(JSON.stringify(obj));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('invalid_shape');
    }
  });

  it('rejects a sig that is not 128 hex chars', () => {
    const obj = {
      assignment_id: 'hw03',
      semester: 'fa26',
      issued_at: '2026-09-15T00:00:00Z',
      files_under_review: ['hw03.py'],
      sig: 'tooshort',
    };
    const result = parseManifest(JSON.stringify(obj));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('invalid_shape');
      if (result.error.kind === 'invalid_shape') {
        expect(result.error.field).toBe('sig');
      }
    }
  });

  it('rejects files_under_review containing non-string elements', () => {
    const obj = {
      assignment_id: 'hw03',
      semester: 'fa26',
      issued_at: '2026-09-15T00:00:00Z',
      files_under_review: [42],
      sig: 'a'.repeat(128),
    };
    const result = parseManifest(JSON.stringify(obj));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('invalid_shape');
    }
  });
});

// ---------------------------------------------------------------------------
// verifyManifest tests
// ---------------------------------------------------------------------------

describe('verifyManifest', () => {
  it('happy path: parse + verify a freshly signed manifest', async () => {
    const { text, pubkeyHex } = await makeSignedManifest();
    const parseResult = parseManifest(text);
    expect(parseResult.ok).toBe(true);
    if (!parseResult.ok) return;

    const verifyResult = await verifyManifest(parseResult.value, pubkeyHex);
    expect(verifyResult.ok).toBe(true);
    if (!verifyResult.ok) return;
    expect(verifyResult.value).toBe(true);
  });

  it('rejects when sig is over different content (tampered manifest)', async () => {
    const { text, pubkeyHex } = await makeSignedManifest();
    const parseResult = parseManifest(text);
    expect(parseResult.ok).toBe(true);
    if (!parseResult.ok) return;

    // Tamper: change assignment_id AFTER signature was produced
    const tampered = { ...parseResult.value, assignment_id: 'hw99' };
    const verifyResult = await verifyManifest(tampered, pubkeyHex);
    expect(verifyResult.ok).toBe(false);
    if (!verifyResult.ok) {
      expect(verifyResult.error.kind).toBe('invalid_signature');
    }
  });

  it('rejects when the wrong public key is supplied', async () => {
    const { text } = await makeSignedManifest();
    const parseResult = parseManifest(text);
    expect(parseResult.ok).toBe(true);
    if (!parseResult.ok) return;

    // Generate a DIFFERENT keypair — its pubkey won't match the signature
    const wrongSecretKey = ed.utils.randomSecretKey();
    const wrongPubkeyBytes = await ed.getPublicKeyAsync(wrongSecretKey);
    const wrongPubkeyHex = bytesToHex(wrongPubkeyBytes);

    const verifyResult = await verifyManifest(parseResult.value, wrongPubkeyHex);
    expect(verifyResult.ok).toBe(false);
    if (!verifyResult.ok) {
      expect(verifyResult.error.kind).toBe('invalid_signature');
    }
  });

  it('rejects when pubkey is not 64 hex chars', async () => {
    const { text } = await makeSignedManifest();
    const parseResult = parseManifest(text);
    expect(parseResult.ok).toBe(true);
    if (!parseResult.ok) return;

    const verifyResult = await verifyManifest(parseResult.value, 'tooshort');
    expect(verifyResult.ok).toBe(false);
    if (!verifyResult.ok) {
      expect(verifyResult.error.kind).toBe('invalid_signature');
    }
  });

  it('signed payload excludes the sig field — signing same payload verifies', async () => {
    // Directly construct a manifest, sign the payload bytes, verify via verifyManifest
    const fields = {
      assignment_id: 'proj01',
      semester: 'sp27',
      issued_at: '2027-01-15T00:00:00Z',
      files_under_review: ['proj01.py', 'utils.py'],
    };

    const secretKey = ed.utils.randomSecretKey();
    const pubkeyBytes = await ed.getPublicKeyAsync(secretKey);
    const pubkeyHex = bytesToHex(pubkeyBytes);

    const payloadBytes = buildPayload(fields);
    const sigBytes = await ed.signAsync(payloadBytes, secretKey);

    // Build a manifest object with the sig and parse it
    const manifestJson = JSON.stringify({ ...fields, sig: bytesToHex(sigBytes) });
    const parseResult = parseManifest(manifestJson);
    expect(parseResult.ok).toBe(true);
    if (!parseResult.ok) return;

    const verifyResult = await verifyManifest(parseResult.value, pubkeyHex);
    expect(verifyResult.ok).toBe(true);
  });

  it('rejects when sig bytes are over different content (manual byte-level test)', async () => {
    // Sign one payload, try to verify against a manifest with different fields
    const secretKey = ed.utils.randomSecretKey();
    const pubkeyBytes = await ed.getPublicKeyAsync(secretKey);
    const pubkeyHex = bytesToHex(pubkeyBytes);

    // Sign payload for hw03
    const payload = buildPayload({
      assignment_id: 'hw03',
      semester: 'fa26',
      issued_at: '2026-09-15T00:00:00Z',
      files_under_review: ['hw03.py'],
    });
    const sigBytes = await ed.signAsync(payload, secretKey);
    const sigHex = bytesToHex(sigBytes);

    // But use sig in a manifest with a different assignment_id
    const tampered = {
      assignment_id: 'hw04', // different!
      semester: 'fa26',
      issued_at: '2026-09-15T00:00:00Z',
      files_under_review: ['hw03.py'],
      sig: sigHex,
    };
    const parseResult = parseManifest(JSON.stringify(tampered));
    expect(parseResult.ok).toBe(true);
    if (!parseResult.ok) return;

    const verifyResult = await verifyManifest(parseResult.value, pubkeyHex);
    expect(verifyResult.ok).toBe(false);
    if (!verifyResult.ok) {
      expect(verifyResult.error.kind).toBe('invalid_signature');
    }
  });

  it('verifyManifest handles a pubkey that is valid hex length but not an actual ed25519 key', async () => {
    const { text } = await makeSignedManifest();
    const parseResult = parseManifest(text);
    expect(parseResult.ok).toBe(true);
    if (!parseResult.ok) return;

    // All-zeros is a syntactically valid 64-hex-char string but not a valid pubkey for this sig
    const zeroPubkey = '0'.repeat(64);
    const verifyResult = await verifyManifest(parseResult.value, zeroPubkey);
    // Should either return invalid_signature or (if the library throws) also invalid_signature
    expect(verifyResult.ok).toBe(false);
    if (!verifyResult.ok) {
      expect(verifyResult.error.kind).toBe('invalid_signature');
    }
  });

  it('hexToBytes and bytesToHex round-trip for a known public key', async () => {
    // Sanity check that the hex helpers we use in the implementation work correctly
    const secretKey = ed.utils.randomSecretKey();
    const pubkeyBytes = await ed.getPublicKeyAsync(secretKey);
    const hex = bytesToHex(pubkeyBytes);
    const roundTripped = hexToBytes(hex);
    expect(roundTripped).toEqual(pubkeyBytes);
    expect(hex).toHaveLength(64);
    expect(hex).toMatch(/^[0-9a-f]+$/);
  });
});
