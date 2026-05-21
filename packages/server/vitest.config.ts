import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    // Integration tests that spawn containers can take a while.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
