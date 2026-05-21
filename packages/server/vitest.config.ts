import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    // Default timeout for unit tests. Integration tests that use testcontainers
    // override this to 120s per-file using vi.setConfig().
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
});
