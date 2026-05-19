/**
 * Unit tests for loadAndVerifyManifest.
 * Tests exercise the file-not-found, parse-error, bad-sig, and happy-path branches.
 * CLAUDE.md: "Do not write tests that exercise VS Code APIs from unit tests. Mock at the seam."
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as ed from '@noble/ed25519';
import { bytesToHex } from '@noble/hashes/utils.js';

// We need to import the function under test AND inject our own pubkey.
// loadAndVerifyManifest accepts an optional pubkeyHex argument, which we use here.
import { loadAndVerifyManifest } from './manifest-loader.js';

// We also need to produce a canonicalized payload for signing (same logic as log-core).
import { canonicalize } from '@provenance/log-core';

// ---------------------------------------------------------------------------
// Test keypair generation helpers (inline — no log-core crypto, just noble + node)
// ---------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
  return Buffer.from(hex, 'hex');
}

/**
 * Generate a fresh ed25519 keypair for each test that needs signing.
 * Uses @noble/ed25519 directly (same library log-core uses) so the signature format matches.
 */
async function generateTestKeypair(): Promise<{ pubkeyHex: string; privkeyHex: string }> {
  // noble/ed25519 v3: utils.randomSecretKey() → 32-byte Uint8Array seed
  const secretKey = ed.utils.randomSecretKey();
  const publicKey = await ed.getPublicKeyAsync(secretKey);
  return {
    pubkeyHex: bytesToHex(publicKey),
    privkeyHex: bytesToHex(secretKey),
  };
}

/**
 * Sign a .cs61a manifest payload (the four content fields, JCS-canonicalized) with the given key.
 * Returns the 128-char hex signature.
 */
async function signManifest(
  manifest: {
    assignment_id: string;
    semester: string;
    issued_at: string;
    files_under_review: string[];
  },
  privkeyHex: string,
): Promise<string> {
  const payload = canonicalize({
    assignment_id: manifest.assignment_id,
    semester: manifest.semester,
    issued_at: manifest.issued_at,
    files_under_review: manifest.files_under_review,
  });
  const payloadBytes = new TextEncoder().encode(payload);
  const sigBytes = await ed.signAsync(payloadBytes, hexToBytes(privkeyHex));
  return bytesToHex(sigBytes);
}

// ---------------------------------------------------------------------------
// Minimal vscode.WorkspaceFolder mock
// ---------------------------------------------------------------------------

function makeWorkspaceFolder(fsPath: string): import('vscode').WorkspaceFolder {
  return {
    uri: {
      fsPath,
      scheme: 'file',
      authority: '',
      path: fsPath,
      query: '',
      fragment: '',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    name: 'test-workspace',
    index: 0,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('loadAndVerifyManifest', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'provenance-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns no_manifest_file when .cs61a does not exist', async () => {
    const folder = makeWorkspaceFolder(tmpDir);
    const result = await loadAndVerifyManifest(folder, 'a'.repeat(64));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('no_manifest_file');
    }
  });

  it('returns manifest_parse_error for malformed JSON', async () => {
    await fs.writeFile(path.join(tmpDir, '.cs61a'), 'not valid json', 'utf8');
    const folder = makeWorkspaceFolder(tmpDir);
    const result = await loadAndVerifyManifest(folder, 'a'.repeat(64));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('manifest_parse_error');
    }
  });

  it('returns manifest_parse_error for JSON that fails shape validation (missing sig)', async () => {
    const badManifest = {
      assignment_id: 'hw03',
      semester: 'fa26',
      issued_at: '2026-09-15T00:00:00Z',
      files_under_review: ['hw03.py'],
      // sig: missing
    };
    await fs.writeFile(path.join(tmpDir, '.cs61a'), JSON.stringify(badManifest), 'utf8');
    const folder = makeWorkspaceFolder(tmpDir);
    const result = await loadAndVerifyManifest(folder, 'a'.repeat(64));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('manifest_parse_error');
    }
  });

  it('returns manifest_signature_invalid for a manifest with an invalid signature', async () => {
    const { pubkeyHex } = await generateTestKeypair();
    // Use a different key to sign than the one we verify with.
    const { privkeyHex: otherPrivkey } = await generateTestKeypair();

    const manifestData = {
      assignment_id: 'hw03',
      semester: 'fa26',
      issued_at: '2026-09-15T00:00:00Z',
      files_under_review: ['hw03.py'],
    };
    const sigHex = await signManifest(manifestData, otherPrivkey);
    const fullManifest = { ...manifestData, sig: sigHex };

    await fs.writeFile(path.join(tmpDir, '.cs61a'), JSON.stringify(fullManifest), 'utf8');
    const folder = makeWorkspaceFolder(tmpDir);

    // Verify with pubkeyHex (from a different keypair than the signing key).
    const result = await loadAndVerifyManifest(folder, pubkeyHex);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('manifest_signature_invalid');
    }
  });

  it('returns manifest_signature_invalid for a manifest with a well-formed but wrong sig', async () => {
    const { pubkeyHex } = await generateTestKeypair();
    // All-zeros sig is 128 hex chars of zeros — valid shape, will fail verification.
    const manifest = {
      assignment_id: 'hw03',
      semester: 'fa26',
      issued_at: '2026-09-15T00:00:00Z',
      files_under_review: ['hw03.py'],
      sig: '0'.repeat(128),
    };

    await fs.writeFile(path.join(tmpDir, '.cs61a'), JSON.stringify(manifest), 'utf8');
    const folder = makeWorkspaceFolder(tmpDir);
    const result = await loadAndVerifyManifest(folder, pubkeyHex);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('manifest_signature_invalid');
    }
  });

  it('returns the parsed manifest when signature is valid', async () => {
    const { pubkeyHex, privkeyHex } = await generateTestKeypair();
    const manifestData = {
      assignment_id: 'hw03',
      semester: 'fa26',
      issued_at: '2026-09-15T00:00:00Z',
      files_under_review: ['hw03.py'],
    };
    const sigHex = await signManifest(manifestData, privkeyHex);
    const fullManifest = { ...manifestData, sig: sigHex };

    await fs.writeFile(path.join(tmpDir, '.cs61a'), JSON.stringify(fullManifest), 'utf8');
    const folder = makeWorkspaceFolder(tmpDir);

    const result = await loadAndVerifyManifest(folder, pubkeyHex);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.assignment_id).toBe('hw03');
      expect(result.value.semester).toBe('fa26');
      expect(result.value.files_under_review).toEqual(['hw03.py']);
      expect(result.value.sig).toBe(sigHex);
    }
  });

  it('handles a read error (e.g. directory where file expected) as manifest_read_error', async () => {
    // Create a directory named .cs61a instead of a file.
    await fs.mkdir(path.join(tmpDir, '.cs61a'));
    const folder = makeWorkspaceFolder(tmpDir);
    const result = await loadAndVerifyManifest(folder, 'a'.repeat(64));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Reading a directory as a file on Node produces EISDIR or similar.
      expect(['manifest_read_error', 'manifest_parse_error']).toContain(result.error.kind);
    }
  });
});
