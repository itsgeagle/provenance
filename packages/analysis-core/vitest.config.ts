import { defineConfig } from 'vitest/config';

// The moved analysis tests build in-memory bundle ZIPs as Blobs via
// buildTestBundle and read them back with JSZip. JSZip reads a Blob through the
// browser FileReader API, which only exists under jsdom — Node's global Blob is
// not readable by JSZip. So these tests run under jsdom, exactly as they did in
// the analyzer package before the move. The production code itself is
// environment-agnostic (the server calls loadBundle with an ArrayBuffer).
export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
