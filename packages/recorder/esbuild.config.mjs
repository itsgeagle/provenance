/**
 * Production bundler for the recorder extension.
 *
 * Produces a single `dist/extension.js` with every runtime dependency inlined
 * (@provenance/log-core, @noble/*, jszip, canonicalize). Only `vscode` is left
 * external — VS Code provides it at activation time.
 *
 * The VSIX is packaged with `vsce package --no-dependencies`, so anything not
 * inlined here cannot be resolved when the extension activates on a student's
 * machine. Don't add things to `external` without also bundling them another way.
 *
 * Used by `npm run build:prod`. The dev `build` script still uses tsc so
 * integration tests and the dev workflow keep working off readable per-file output.
 */

import * as esbuild from 'esbuild';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

await rm(path.join(__dirname, 'dist'), { recursive: true, force: true });

await esbuild.build({
  entryPoints: [path.join(__dirname, 'src/extension.ts')],
  bundle: true,
  outfile: path.join(__dirname, 'dist/extension.js'),
  platform: 'node',
  format: 'esm',
  target: 'node20',
  // `vscode` is provided by the Extension Host at runtime, not from node_modules.
  external: ['vscode'],
  sourcemap: true,
  mainFields: ['module', 'main'],
  // Some bundled CJS deps (e.g. canonicalize, jszip) reach for `require` at runtime
  // even when transpiled into an ESM output. Synthesizing a `require` shim at the
  // top of the file via createRequire makes those references resolve correctly.
  banner: {
    js: "import { createRequire as __provenanceCreateRequire } from 'node:module'; const require = __provenanceCreateRequire(import.meta.url);",
  },
  logLevel: 'info',
});
