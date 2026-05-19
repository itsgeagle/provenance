import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      vscode: path.resolve('./src/__mocks__/vscode.ts'),
    },
  },
  test: {
    include: ['test/perf/**/*.ts'],
    environment: 'node',
  },
});
