/**
 * The course's offline-signing public key, hex-encoded ed25519 (32 bytes => 64 hex chars).
 *
 * The constant in this file is the DEV keypair from .notes/dev-keypair.json; that's
 * what the recorder uses during local development and integration tests. To produce
 * a production VSIX with the real course public key, run:
 *
 *   PROVENANCE_COURSE_PUBLIC_KEY_HEX=<hex> npm run build:prod --workspace packages/recorder
 *
 * `build:prod` invokes tools/embed-course-key.ts to overwrite the constant below
 * before building and packaging, then `git checkout`'s this file to restore the dev
 * key for further local work. See tools/embed-course-key.ts for the contract this
 * file must honor (file shape, constant name, line format).
 */
export const COURSE_PUBLIC_KEY_HEX =
  '46f91d5902c53816110b05ddedd2b8caa95b452d51e696f5327b52bf90bf4838';
