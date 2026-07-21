/**
 * Export language-neutral conformance vectors from log-core (+ a golden bundle from
 * analysis-core's test-support builder) for the provenance-jetbrains-recorder repo's
 * `core/` conformance suite to consume.
 *
 * This is the single generated source of truth for cross-language format parity. The
 * JetBrains recorder is a second implementation of log-core's format; its `core/` tests
 * read these vectors and assert byte-for-byte agreement. If log-core's format or crypto
 * framing ever changes, re-running this script and re-committing its output in the
 * JetBrains repo is how the change propagates — never hand-edit a vector over there.
 *
 * The values here are pinned to the exact fixed keys the JetBrains repo's ConformanceTest
 * already expects (ed25519 seeds are all-`0x07`/`0x09`/`0x03`/`0x04`/`0x05` fills; HKDF
 * salt/nonce are fixed `0x11`/`0x22` fills), so regenerating reproduces the committed
 * fixtures byte-for-byte — the drift check that proves this export is faithful to the
 * hand-authored originals.
 *
 * Two independent vector families, selected by flag:
 *
 *   --out           log-core FORMAT vectors: hash chain, ed25519, session key, manifests,
 *                   checkpoint, golden bundle. Consumed by JetBrains `core/` and by the
 *                   Neovim `tests/conformance/fixtures/`.
 *   --recorder-out  recorder PAYLOAD-BUILDER vectors: the paste and fs.external_change
 *                   inline-content builders. These pin the inline/truncate cap (64 KB of
 *                   UTF-8) and the deliberate unit mismatch between the byte-based gate
 *                   and the code-unit-based head/tail slice.
 *
 * At least one flag is required; both may be given. Directories are created if missing
 * and same-named files are overwritten — this script owns those contents.
 *
 * USAGE
 *   node --experimental-strip-types tools/export-conformance-vectors.ts --out <dir>
 *
 * Examples (writing directly into the sibling repos on this machine):
 *   node --experimental-strip-types tools/export-conformance-vectors.ts \
 *     --out ../provenance-jetbrains-recorder/core/src/test/resources/conformance
 *
 *   node --experimental-strip-types tools/export-conformance-vectors.ts \
 *     --recorder-out ../provenance-jetbrains-recorder/recorder/src/test/resources/conformance
 *
 *   node --experimental-strip-types tools/export-conformance-vectors.ts \
 *     --out ../provenance-neovim-recorder/tests/conformance/fixtures \
 *     --recorder-out ../provenance-neovim-recorder/tests/conformance/fixtures
 *
 * Requires `npm run build` for log-core, analysis-core, and (for --recorder-out) recorder.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ed from '@noble/ed25519';
import { sha512, sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import {
  sha256Hex,
  chainEntry,
  GENESIS_PREV_HASH,
  signManifest,
  signBundleManifest,
  signCheckpoint,
} from '@provenance/log-core';
import { buildTestBundle } from '@provenance/analysis-core/test-support/build-test-bundle.js';
// The recorder's SHIPPED builders, from its build output — deriving the vectors
// from the real code is the whole point. Requires
// `npm run build --workspace=packages/recorder` first.
import { buildExternalChangeContent } from '../packages/recorder/dist/events/external-change-content.js';
import { buildPastePayload } from '../packages/recorder/dist/events/paste-payload.js';

// Wire sha512 for @noble/ed25519 (same pattern as log-core's own callers).
ed.hashes.sha512 = sha512;
(ed.hashes as Record<string, unknown>)['sha512Async'] = (m: Uint8Array) =>
  Promise.resolve(sha512(m));

const toHex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const fromHex = (h: string): Uint8Array => new Uint8Array(Buffer.from(h, 'hex'));
const seed = (n: number): Uint8Array => new Uint8Array(32).fill(n);
const pub = async (priv: Uint8Array): Promise<string> => toHex(await ed.getPublicKeyAsync(priv));

function parseArgs(argv: string[]): { out: string | null; recorderOut: string | null } {
  const flag = (name: string): string | null => {
    const idx = argv.indexOf(name);
    if (idx === -1) return null;
    const value = argv[idx + 1];
    if (!value) {
      console.error(`${name} requires a directory argument`);
      process.exit(1);
    }
    return value;
  };

  const out = flag('--out');
  const recorderOut = flag('--recorder-out');

  if (out === null && recorderOut === null) {
    console.error(
      'usage: export-conformance-vectors.ts [--out <dir>] [--recorder-out <dir>]\n' +
        '  --out           log-core format vectors (hash chain, ed25519, manifests, golden bundle)\n' +
        '  --recorder-out  recorder payload-builder vectors (paste + fs.external_change content)\n' +
        'At least one is required; both may be given.',
    );
    process.exit(1);
  }
  return { out, recorderOut };
}

function writeJson(outDir: string, name: string, value: unknown): void {
  fs.writeFileSync(path.join(outDir, name), JSON.stringify(value, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Recorder payload-builder vectors
// ---------------------------------------------------------------------------

/**
 * Inputs for the recorder's two content builders. These are the cross-language
 * contract: all three recorders must produce byte-identical payloads for them.
 *
 * Two independent things are being pinned, and the emoji/€ cases exist because
 * only multi-byte text can tell them apart:
 *
 *   1. THE GATE VALUE. Inline vs truncate is decided on UTF-8 BYTE length
 *      against MAX_INLINE_BYTES (64 KB, raised from 4 KB). The 8 KB case sits
 *      between the old and new caps and expects INLINE, so an implementation
 *      still using 4096 fails it immediately.
 *   2. THE UNIT MISMATCH. The gate is bytes, but the head/tail SLICE is UTF-16
 *      code units, so truncation can never split a codepoint. An implementation
 *      that measures the gate in characters, or slices by bytes, fails here.
 *
 * '😀' is 4 UTF-8 bytes / 2 UTF-16 code units; '€' is 3 bytes / 1 code unit.
 * Both are included because they fail differently under a byte/char mixup.
 *
 * Size note: the at-boundary cases are inherently ~64 KB of input each, which
 * is why this list is deliberately short. Every large case earns its place.
 */
function recorderContentInputs(): Array<{ note: string; input: string }> {
  const EMOJI = '😀'; // 4 UTF-8 bytes, 2 UTF-16 code units
  const EURO = '€'; // 3 UTF-8 bytes, 1 UTF-16 code unit
  const CAP = 64 * 1024;

  return [
    { note: 'ascii, small: inlined', input: 'hello world' },
    { note: 'empty string: inlined as ""', input: '' },
    {
      note: 'multibyte, small: inlined; size is UTF-8 bytes, not codepoints',
      input: '日本語のテキストです。これはテストです。',
    },
    {
      note: 'multibyte, 8 KB: between the old 4 KB cap and the new 64 KB cap, so this INLINES. An implementation still gated at 4096 truncates here and fails.',
      input: EMOJI.repeat(2048), // 8192 bytes, 4096 code units
    },
    {
      note: 'multibyte, EXACTLY at the 64 KB cap in bytes (boundary inclusive → inlines). Only 32768 code units, so a char-based gate would also inline — the next case is what separates them.',
      input: EMOJI.repeat(CAP / 4), // 65536 bytes, 32768 code units
    },
    {
      note: 'multibyte, ONE codepoint past the cap in bytes → truncates. Still only 32770 code units, far under 65536, so a char-based gate wrongly inlines and fails.',
      input: EMOJI.repeat(CAP / 4 + 1), // 65540 bytes, 32770 code units
    },
    {
      note: '3-byte characters past the cap, with distinct head/tail markers: pins that the slice is by code unit and that head/tail are taken from the right ends.',
      input: `HEAD-${EURO.repeat(CAP / 3)}-TAIL`, // > 64 KB, 1 code unit per char
    },
  ];
}

/**
 * Emit the recorder payload-builder conformance fixtures.
 *
 * Both files are arrays of { note, input, expected }. `expected` omits fields
 * the builder leaves undefined, so a consumer comparing all fields (including
 * absent ones) sees null/nil on both sides.
 *
 * Deterministic by construction: fixed inputs, no clock, no randomness, no
 * iteration over unordered collections. Running this twice produces identical
 * bytes.
 */
function writeRecorderVectors(outDir: string): void {
  const inputs = recorderContentInputs();

  writeJson(
    outDir,
    'external-change-content.json',
    inputs.map(({ note, input }) => ({
      note,
      input,
      expected: buildExternalChangeContent(input),
    })),
  );

  writeJson(
    outDir,
    'paste-payload.json',
    inputs.map(({ note, input }) => ({
      note,
      input,
      expected: buildPastePayload(input),
    })),
  );
}

async function main(): Promise<void> {
  const { out, recorderOut } = parseArgs(process.argv.slice(2));

  if (recorderOut !== null) {
    const recorderDir = path.resolve(recorderOut);
    fs.mkdirSync(recorderDir, { recursive: true });
    writeRecorderVectors(recorderDir);
    console.log(`Wrote recorder payload vectors to ${recorderDir}`);
  }

  if (out === null) return;

  const outDir = path.resolve(out);
  fs.mkdirSync(outDir, { recursive: true });

  // --- 1. sha256 + hash-chain vectors (pinned; compact layout preserved verbatim) ---
  const chainEnvelope = {
    seq: 0,
    t: 0,
    wall: '2026-01-01T00:00:00.000Z',
    kind: 'session.end',
    data: { reason: 'test' },
  };
  const vectorsText = `{
  "source": "log-core hash-chain.test.ts (pinned)",
  "sha256": [
    { "input": "hello world", "hex": "${sha256Hex('hello world')}" },
    { "input": "", "hex": "${sha256Hex('')}" }
  ],
  "chain": [
    {
      "prev_hash": "${GENESIS_PREV_HASH}",
      "envelope": { "seq": 0, "t": 0, "wall": "2026-01-01T00:00:00.000Z", "kind": "session.end", "data": { "reason": "test" } },
      "hash": "${chainEntry(GENESIS_PREV_HASH, chainEnvelope).hash}"
    }
  ]
}
`;
  fs.writeFileSync(path.join(outDir, 'vectors.json'), vectorsText);

  // --- 2. ed25519 vector (seed 0x07, message {"a":1}) ---
  const edPriv = seed(7);
  const edMsg = '{"a":1}';
  const edSig = toHex(await ed.signAsync(new TextEncoder().encode(edMsg), edPriv));
  writeJson(outDir, 'ed25519.json', {
    priv_hex: toHex(edPriv),
    msg_utf8: edMsg,
    pub_hex: await pub(edPriv),
    sig_hex: edSig,
  });

  // --- 3. signed .provenance-manifest vector (course seed 0x09) ---
  const coursePriv = seed(9);
  const manifestFields = {
    assignment_id: 'hw3',
    semester: 'fa25',
    issued_at: '2026-07-14T00:00:00Z',
    files_under_review: ['src/main.py', 'src/util.py'],
  };
  const manifestSig = await signManifest(manifestFields, coursePriv);
  writeJson(outDir, 'manifest.json', {
    course_pubkey_hex: await pub(coursePriv),
    manifest: { ...manifestFields, sig: manifestSig },
  });

  // --- 4. signed bundle-manifest vector (session seed 0x03) ---
  const bundlePriv = seed(3);
  const bundleManifest = {
    format_version: '1.1' as const,
    assignment_id: 'hw3',
    semester: 'fa25',
    extension_hash: 'a'.repeat(64),
    sessions: [
      {
        session_id: '11111111-1111-4111-8111-111111111111',
        prev_session_id: null,
        slog_sha256: 'b'.repeat(64),
        meta_sha256: 'c'.repeat(64),
      },
      {
        session_id: '22222222-2222-4222-8222-222222222222',
        prev_session_id: '11111111-1111-4111-8111-111111111111',
        slog_sha256: 'd'.repeat(64),
        meta_sha256: 'e'.repeat(64),
      },
    ],
    submission_files: [
      { path: 'src/main.py', status: 'present' as const, sha256: 'f'.repeat(64) },
      { path: 'src/missing.py', status: 'missing' as const, sha256: null },
    ],
  };
  const signedBundle = await signBundleManifest(bundleManifest, bundlePriv);
  writeJson(outDir, 'bundle-manifest.json', {
    session_pubkey_hex: await pub(bundlePriv),
    manifest: bundleManifest,
    canonical_json: signedBundle.canonicalJson,
    signature_hex: signedBundle.signatureHex,
  });

  // --- 5. session privkey encryption vector (privkey seed 0x05, fixed salt/nonce) ---
  // encryptSessionPrivkey() draws salt/nonce from randomBytes internally, so to pin a
  // reproducible ciphertext we replicate its exact primitives with fixed inputs:
  // HKDF-SHA256(IKM = manifest sig bytes, salt, info) -> XChaCha20-Poly1305.
  const skPriv = seed(5);
  const salt = new Uint8Array(16).fill(0x11);
  const nonce = new Uint8Array(24).fill(0x22);
  const info = 'provenance-session-key-v1';
  const hkdfKey = hkdf(sha256, fromHex(manifestSig), salt, new TextEncoder().encode(info), 32);
  const ciphertext = xchacha20poly1305(hkdfKey, nonce).encrypt(skPriv);
  writeJson(outDir, 'session-key.json', {
    privkey_hex: toHex(skPriv),
    pubkey_hex: await pub(skPriv),
    manifest_sig: manifestSig,
    salt_hex: toHex(salt),
    nonce_hex: toHex(nonce),
    info,
    hkdf_key_hex: toHex(hkdfKey),
    ciphertext_hex: toHex(ciphertext),
    algorithm: 'xchacha20-poly1305-hkdf-sha256-v1',
  });

  // --- 6. signed checkpoint vector (session seed 0x04) ---
  const ckptPriv = seed(4);
  const checkpoint = await signCheckpoint(128, 'ab'.repeat(32), ckptPriv);
  writeJson(outDir, 'checkpoint.json', {
    session_pubkey_hex: await pub(ckptPriv),
    seq: checkpoint.seq,
    hash: checkpoint.hash,
    sig: checkpoint.sig,
  });

  // --- 7. golden full bundle (built from analysis-core's test-support builder) ---
  // A complete, self-consistent sealed bundle straight from analysis-core, so the
  // JetBrains core/ can assert its manifest conforms to the shared shape. Not compared
  // byte-for-byte (there is no committed original); it is a fresh, deterministic build.
  const golden = await buildTestBundle({
    assignmentId: 'golden-hw',
    semester: 'fa26',
    sessions: [{ eventCount: 8, appendDocSave: true }],
  });
  fs.writeFileSync(path.join(outDir, 'golden-bundle.zip'), Buffer.from(golden.zipBuffer));
  writeJson(outDir, 'golden-bundle.json', {
    note:
      'Sidecar for golden-bundle.zip, generated by tools/export-conformance-vectors.ts. ' +
      'The manifest below is the sealed BundleManifest; core/ asserts it validates via ' +
      'validateBundleManifestShape. Full zip round-trip awaits a core/ zip loader.',
    manifest: golden.manifest,
    session_pubkey_hex: await pub(fromHex(golden.sessionPrivkeyHex)),
  });

  console.log(`Wrote conformance vectors to ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
