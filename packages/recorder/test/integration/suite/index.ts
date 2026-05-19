/**
 * Mocha test runner setup for the Provenance Recorder integration tests.
 *
 * This file is the entry point called by @vscode/test-electron after it
 * launches VS Code with the extension loaded. It sets up Mocha and discovers
 * all *.test.js files under this directory.
 *
 * The exported `run` function signature is mandated by @vscode/test-electron.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import Mocha from 'mocha';
import { glob } from 'glob';

export async function run(): Promise<void> {
  const mocha = new Mocha({
    ui: 'tdd',
    color: true,
    timeout: 30_000, // 30s per test — VS Code startup can be slow.
  });

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const testsRoot = path.resolve(__dirname, '.');

  // glob@13 returns a Promise<string[]>; no callback API.
  const files = await glob('**/**.test.js', { cwd: testsRoot });
  for (const f of files) {
    mocha.addFile(path.resolve(testsRoot, f));
  }

  await new Promise<void>((resolve, reject) => {
    try {
      mocha.run((failures) => {
        if (failures > 0) {
          reject(new Error(`${failures} test(s) failed.`));
        } else {
          resolve();
        }
      });
    } catch (e) {
      reject(e);
    }
  });
}
