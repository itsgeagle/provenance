/**
 * Generate the course's offline ed25519 keypair.
 *
 * USE THIS ONLY ON A SECURED MACHINE.
 *
 * The private key produced by this script is what authorizes every `.provenance-manifest` manifest
 * the course distributes. Anyone with it can forge a valid manifest, which would let
 * an attacker run the recorder on arbitrary folders and produce convincing logs.
 * Treat it like the course's most sensitive credential:
 *
 *   - run on an air-gapped or otherwise hardened machine
 *   - never paste the private key into chat, email, CI, or any logging system
 *   - back it up to physical media (USB / printed paper) before deleting from disk
 *   - rotate per-semester or sooner if you suspect exposure
 *
 * What the script does:
 *   1. Generates a fresh ed25519 keypair via `node:crypto.generateKeyPairSync`.
 *   2. Prints the public key (64 hex chars) to stdout — this is what gets embedded
 *      in the recorder via `tools/embed-course-key.ts` or pasted directly into
 *      `packages/recorder/src/activation/course-keys.ts`.
 *   3. Writes the private key to a path you specify on the command line. Refuses to
 *      overwrite, refuses to write inside the repo, and emits no other output.
 *
 * Usage:
 *   node --experimental-strip-types tools/generate-course-keypair.ts <privkey-out-path>
 *
 * Example:
 *   node --experimental-strip-types tools/generate-course-keypair.ts /Volumes/COURSE-KEY/cs61a-fa26.json
 *
 * The output file is JSON:
 *   {
 *     "public_key_hex": "<64 hex chars>",
 *     "private_key_hex": "<64 hex chars>",
 *     "generated_at": "<ISO 8601 UTC>",
 *     "note": "Course offline-signing key. Keep secret. See tools/generate-course-keypair.ts."
 *   }
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

function bytesToHex(buf: Buffer): string {
  return buf.toString('hex');
}

function generateKeypair(): { privateKeyHex: string; publicKeyHex: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    publicKeyEncoding: { type: 'spki', format: 'der' },
  });

  // PKCS8 DER for ed25519: raw 32-byte seed at byte offset 16.
  // SPKI DER for ed25519: raw 32-byte public key at byte offset 12.
  const seedBytes = (privateKey as Buffer).subarray(16, 48);
  const pubkeyBytes = (publicKey as Buffer).subarray(12, 44);

  return {
    privateKeyHex: bytesToHex(seedBytes),
    publicKeyHex: bytesToHex(pubkeyBytes),
  };
}

function die(message: string): never {
  process.stderr.write(`[generate-course-keypair] ${message}\n`);
  process.exit(1);
}

function main(): void {
  const outPathArg = process.argv[2];
  if (outPathArg === undefined) {
    die(
      'Missing output path.\n' +
        'Usage: node --experimental-strip-types tools/generate-course-keypair.ts <privkey-out-path>\n' +
        'Example: ... /Volumes/COURSE-KEY/cs61a-fa26.json',
    );
  }

  const outPath = path.resolve(outPathArg);

  // Refuse to write inside the repo. Anyone running this script should be writing
  // to a USB drive or another secured volume — never into the source tree.
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  if (outPath.startsWith(repoRoot + path.sep) || outPath === repoRoot) {
    die(
      `Refusing to write the private key inside the repo (${outPath}).\n` +
        'Choose a path on a secured/removable volume.',
    );
  }

  // Refuse to overwrite. If the destination exists, the caller likely intended a
  // different path and we don't want to clobber an existing offline key.
  if (fs.existsSync(outPath)) {
    die(
      `Refusing to overwrite an existing file at ${outPath}.\n` +
        'Choose a fresh path, or delete the existing file deliberately first.',
    );
  }

  // Ensure the parent directory exists. Don't auto-create deep paths — fail
  // loudly so the operator knows where they're writing.
  const parent = path.dirname(outPath);
  if (!fs.existsSync(parent)) {
    die(`Parent directory does not exist: ${parent}\nCreate it first, then re-run.`);
  }

  // Generate.
  const { privateKeyHex, publicKeyHex } = generateKeypair();

  // Write the private key to the secured path with restrictive permissions.
  const fileContents = {
    public_key_hex: publicKeyHex,
    private_key_hex: privateKeyHex,
    generated_at: new Date().toISOString(),
    note: 'Course offline-signing key. Keep secret. See tools/generate-course-keypair.ts.',
  };
  fs.writeFileSync(outPath, JSON.stringify(fileContents, null, 2) + '\n', { mode: 0o600 });

  // Print only the public key to stdout. Anything else goes to stderr so the
  // operator can pipe stdout straight into a clipboard or a build script.
  process.stdout.write(publicKeyHex + '\n');

  process.stderr.write(
    `[generate-course-keypair] Wrote private key to: ${outPath} (mode 0600)\n` +
      `[generate-course-keypair] Public key (stdout above): ${publicKeyHex}\n` +
      `[generate-course-keypair] Next steps:\n` +
      `  1. Back up ${outPath} to physical media. Verify the backup.\n` +
      `  2. Embed the public key into the recorder build (see tools/embed-course-key.ts\n` +
      `     once it exists, or paste the hex into packages/recorder/src/activation/course-keys.ts).\n` +
      `  3. Sign your first .provenance-manifest file with tools/sign-manifest.ts, pointing it at\n` +
      `     this file instead of .notes/dev-keypair.json.\n` +
      `  4. Once you're satisfied with the backup, securely delete the local copy of ${outPath}.\n`,
  );
}

main();
