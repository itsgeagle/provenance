import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      // Replace the vscode module (not available outside the Extension Host)
      // with a minimal mock for unit tests.
      vscode: path.resolve('./src/__mocks__/vscode.ts'),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
