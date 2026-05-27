import { defineConfig } from 'vitest/config';

// Perf tests assert wall-clock budgets and flake under loaded CI. They are
// excluded from the default `npm run test` and run via `npm run test:perf`
// (P1-1). The exclusion is opt-out: ANALYZE_PERF=1 keeps them in the default
// run so a local invocation that explicitly wants them can opt in.
const includePerf = process.env.ANALYZE_PERF === '1';
const excludePerf = includePerf ? [] : ['test/perf/**'];

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', ...excludePerf],
    environment: 'node',
    // Default timeout for unit tests. Integration tests that use testcontainers
    // override this to 120s per-file using vi.setConfig().
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
});
