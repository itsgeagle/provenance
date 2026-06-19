/**
 * Dev tooling: generate an ed25519 keypair and sign a .provenance-manifest file.
 *
 * Usage (run once to generate keypair + sign test-workspace/.provenance-manifest):
 *   node --experimental-strip-types tools/sign-manifest.ts
 *
 * The keypair is saved to .notes/dev-keypair.json (git-excluded via .git/info/exclude).
 * Only the public key should be copied into packages/recorder/src/activation/course-keys.ts.
 * The private key NEVER enters the repo.
 *
 * Signing payload: canonicalize({assignment_id, semester, issued_at, files_under_review})
 * — same as manifest.ts in log-core.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import canonicalizeLib from 'canonicalize';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

// Default to the dev keypair under .notes/. Course staff signing real assignments
// should set PROVENANCE_COURSE_KEYPAIR_PATH to point at the offline-generated key
// (produced by tools/generate-course-keypair.ts).
const KEYPAIR_PATH =
  process.env.PROVENANCE_COURSE_KEYPAIR_PATH ?? path.join(REPO_ROOT, '.notes', 'dev-keypair.json');

// Default target manifest; can be overridden by passing a path as argv[2].
const manifestPath =
  process.argv[2] ?? path.join(REPO_ROOT, 'test-workspace', '.provenance-manifest');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type StoredKeypair = {
  public_key_hex: string;
  private_key_hex: string;
};

type ManifestJson = {
  assignment_id: string;
  semester: string;
  issued_at: string;
  files_under_review: string[];
  sig?: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function hexToBytes(hex: string): Buffer {
  return Buffer.from(hex, 'hex');
}

/**
 * Generate an ed25519 keypair using Node's built-in crypto.
 * Extracts the raw 32-byte seed and public key from DER-encoded output.
 *
 * PKCS8 DER for ed25519: raw 32-byte seed starts at byte offset 16.
 * SPKI DER for ed25519: raw 32-byte public key starts at byte offset 12.
 */
function generateKeypair(): { privateKeyHex: string; publicKeyHex: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    publicKeyEncoding: { type: 'spki', format: 'der' },
  });

  const seedBytes = (privateKey as Buffer).subarray(16, 48);
  const pubkeyBytes = (publicKey as Buffer).subarray(12, 44);

  return {
    privateKeyHex: bytesToHex(seedBytes),
    publicKeyHex: bytesToHex(pubkeyBytes),
  };
}

/**
 * Sign a message with an ed25519 private key seed (32 bytes).
 * Wraps the raw seed into PKCS8 DER format for Node's crypto.sign.
 * Returns the 64-byte signature as a 128-char hex string.
 */
function signMessage(message: Uint8Array, privateKeySeedHex: string): string {
  const seedBytes = hexToBytes(privateKeySeedHex);

  // PKCS8 DER header for ed25519 (16 bytes) followed by the 32-byte seed.
  // Header: SEQUENCE { INTEGER 0, SEQUENCE { OID 1.3.101.112 }, OCTET STRING { OCTET STRING seed } }
  const pkcs8Header = Buffer.from('302e020100300506032b657004220420', 'hex');
  const pkcs8Der = Buffer.concat([pkcs8Header, seedBytes]);

  const keyObj = crypto.createPrivateKey({ key: pkcs8Der, format: 'der', type: 'pkcs8' });
  const sigBuffer = crypto.sign(null, Buffer.from(message), keyObj);
  return bytesToHex(sigBuffer);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Step 1: Load or generate keypair.
  let keypair: StoredKeypair;

  if (fs.existsSync(KEYPAIR_PATH)) {
    console.log(`[sign-manifest] Loading existing keypair from ${KEYPAIR_PATH}`);
    const raw = fs.readFileSync(KEYPAIR_PATH, 'utf8');
    keypair = JSON.parse(raw) as StoredKeypair;
  } else {
    console.log('[sign-manifest] Generating new ed25519 keypair...');
    const { privateKeyHex, publicKeyHex } = generateKeypair();
    keypair = { public_key_hex: publicKeyHex, private_key_hex: privateKeyHex };
    fs.writeFileSync(KEYPAIR_PATH, JSON.stringify(keypair, null, 2) + '\n', { mode: 0o600 });
    console.log(`[sign-manifest] Keypair saved to ${KEYPAIR_PATH}`);
  }

  console.log(`[sign-manifest] Public key: ${keypair.public_key_hex}`);

  // Step 2: Read the target manifest.
  if (!fs.existsSync(manifestPath)) {
    console.error(`[sign-manifest] ERROR: manifest not found at ${manifestPath}`);
    process.exit(1);
  }

  const rawManifest = fs.readFileSync(manifestPath, 'utf8');
  let manifest: ManifestJson;
  try {
    manifest = JSON.parse(rawManifest) as ManifestJson;
  } catch (e) {
    console.error(`[sign-manifest] ERROR: failed to parse manifest JSON: ${e}`);
    process.exit(1);
  }

  // Step 3: Strip existing sig field and build signing payload.
  // The sig covers only the four content fields (PRD §4.1 / manifest.ts in log-core).
  const { sig: _existingSig, ...payloadFields } = manifest;
  const signingPayload = canonicalizeLib({
    assignment_id: payloadFields.assignment_id,
    semester: payloadFields.semester,
    issued_at: payloadFields.issued_at,
    files_under_review: payloadFields.files_under_review,
  });

  if (signingPayload === undefined) {
    console.error('[sign-manifest] ERROR: canonicalize returned undefined');
    process.exit(1);
  }

  console.log(`[sign-manifest] Signing payload: ${signingPayload}`);

  // Step 4: Sign the UTF-8 bytes of the canonical JSON.
  const payloadBytes = new TextEncoder().encode(signingPayload);
  const sigHex = signMessage(payloadBytes, keypair.private_key_hex);

  // Step 5: Attach sig and write back.
  const signedManifest: ManifestJson = {
    ...payloadFields,
    sig: sigHex,
  };

  const canonicalOutput = canonicalizeLib(signedManifest);
  if (canonicalOutput === undefined) {
    console.error('[sign-manifest] ERROR: canonicalize returned undefined for output');
    process.exit(1);
  }
  fs.writeFileSync(manifestPath, canonicalOutput + '\n');
  console.log(`[sign-manifest] Manifest signed and written to ${manifestPath}`);
  console.log(`[sign-manifest] sig (128 hex chars): ${sigHex}`);
  console.log('\n[sign-manifest] PASTE THIS INTO packages/recorder/src/activation/course-keys.ts:');
  console.log(`  COURSE_PUBLIC_KEY_HEX = '${keypair.public_key_hex}'`);
}

main().catch((e: unknown) => {
  console.error('[sign-manifest] Fatal error:', e);
  process.exit(1);
});
