/**
 * Embed the course's production public key into the recorder source so that the
 * built VSIX trusts only manifests signed by the real course offline key.
 *
 * USAGE
 *   PROVENANCE_COURSE_PUBLIC_KEY_HEX=<64-hex> node --experimental-strip-types tools/embed-course-key.ts
 *
 * Typically invoked via `npm run build:prod --workspace packages/recorder`, which
 * runs this script, then `npm run build`, then `npm run package`, then restores the
 * source file via `git checkout`.
 *
 * Behavior:
 *   1. Reads PROVENANCE_COURSE_PUBLIC_KEY_HEX from the environment.
 *   2. Refuses to run if the env var is missing, malformed (not 64 lowercase hex),
 *      or equal to the dev key checked into the repo (so a misconfigured release
 *      can never silently ship the dev key).
 *   3. Rewrites packages/recorder/src/activation/course-public-key.ts so that the
 *      `COURSE_PUBLIC_KEY_HEX` constant equals the supplied value. Preserves the
 *      rest of the file verbatim.
 *
 * The script never logs the dev key in error messages. It does log the production
 * key (which is, by definition, public) for build-transparency confirmation.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const TARGET = path.join(REPO_ROOT, 'packages/recorder/src/activation/course-public-key.ts');

const HEX_64 = /^[0-9a-f]{64}$/;

// Dev key hardcoded here so the script can refuse to "embed" it as a no-op.
// Must be kept in sync with .notes/dev-keypair.json (the dev key the recorder ships
// with for local builds). If you rotate the dev key, update this constant too.
const DEV_PUBLIC_KEY_HEX = '46f91d5902c53816110b05ddedd2b8caa95b452d51e696f5327b52bf90bf4838';

function die(message: string): never {
  process.stderr.write(`[embed-course-key] ${message}\n`);
  process.exit(1);
}

function main(): void {
  const hex = process.env['PROVENANCE_COURSE_PUBLIC_KEY_HEX'];
  if (hex === undefined || hex === '') {
    die(
      'PROVENANCE_COURSE_PUBLIC_KEY_HEX is not set.\n' +
        'Set it to the production course public key (64 lowercase hex chars) and re-run.',
    );
  }
  if (!HEX_64.test(hex)) {
    die(
      `PROVENANCE_COURSE_PUBLIC_KEY_HEX is malformed: expected 64 lowercase hex chars, got ${hex.length} chars.\n` +
        'Produce one via tools/generate-course-keypair.ts on a secured machine.',
    );
  }
  if (hex === DEV_PUBLIC_KEY_HEX) {
    die(
      'PROVENANCE_COURSE_PUBLIC_KEY_HEX equals the dev key checked into the repo.\n' +
        'Production builds must use a different key. Generate one via tools/generate-course-keypair.ts.',
    );
  }

  if (!fs.existsSync(TARGET)) {
    die(`Target file not found: ${TARGET}`);
  }

  const original = fs.readFileSync(TARGET, 'utf8');

  // Replace the constant. The source file commits to a single-line definition for
  // exactly this reason; a regex over multi-line bodies would be fragile.
  const pattern = /(export const COURSE_PUBLIC_KEY_HEX\s*=\s*)['"][0-9a-f]{64}['"]/;
  if (!pattern.test(original)) {
    die(
      `Could not locate the COURSE_PUBLIC_KEY_HEX constant in ${TARGET}.\n` +
        'The file shape may have drifted from what tools/embed-course-key.ts expects.\n' +
        'Either update the regex in this script or restore the file from git.',
    );
  }

  const rewritten = original.replace(pattern, `$1'${hex}'`);

  fs.writeFileSync(TARGET, rewritten, 'utf8');

  process.stderr.write(
    `[embed-course-key] Embedded production public key into:\n` +
      `  ${TARGET}\n` +
      `[embed-course-key] Embedded key (public, hex): ${hex}\n` +
      `[embed-course-key] Build the VSIX now; then \`git checkout ${path.relative(REPO_ROOT, TARGET)}\`\n` +
      `[embed-course-key] to restore the dev key for further local work.\n`,
  );
}

main();
