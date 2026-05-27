import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// Perf tests assert wall-clock budgets and flake under loaded CI. They are
// excluded from the default `npm run test` and run via `npm run test:perf`
// (V46). The exclusion is opt-out: ANALYZE_PERF=1 keeps them in the default
// run, so a local invocation that explicitly wants them can opt in.
const includePerf = process.env.ANALYZE_PERF === '1';
const excludePerf = includePerf ? [] : ['test/perf/**'];

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    globals: true,
    exclude: ['**/node_modules/**', '**/dist/**', ...excludePerf],
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
