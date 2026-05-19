/**
 * Integration test runner for the Provenance Recorder extension.
 *
 * This script uses @vscode/test-electron to:
 *  1. Download VS Code (cached in .vscode-test/) if not already present.
 *  2. Launch VS Code with the recorder extension loaded.
 *  3. Run the test suite in test/integration/suite/index.js.
 *
 * Run via: npm run test:integration
 *
 * NOTE: This test harness requires mocha to be installed:
 *   npm install --save-dev mocha @types/mocha
 * It is NOT part of the default `npm run test` (which runs Vitest unit tests).
 *
 * @vscode/test-electron downloads VS Code on first run; subsequent runs use the
 * cached version in .vscode-test/. The test:integration script compiles this
 * harness via tsc before running it.
 */

import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  // Root of the recorder package — this is where package.json lives.
  const extensionDevelopmentPath = path.resolve(__dirname, '../..');

  // The compiled suite index (after `tsc -p tsconfig.integration.json`).
  // @vscode/test-electron will look for dist-integration/test/integration/suite/index.js
  // and call its exported `run()` function.
  const extensionTestsPath = path.resolve(__dirname, '../suite/index');

  // The test-workspace that contains a valid .cs61a marker file.
  const testWorkspacePath = path.resolve(__dirname, '../../../../test-workspace');

  try {
    await runTests({
      // VS Code version to download. 'stable' always fetches the latest stable.
      version: 'stable',
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        testWorkspacePath,
        // Disable other extensions to avoid interference.
        '--disable-extensions',
        // Keep the Extension Host from asking for trust.
        '--disable-workspace-trust',
      ],
    });
  } catch (err) {
    console.error('Integration tests failed:', err);
    process.exit(1);
  }
}

void main();
