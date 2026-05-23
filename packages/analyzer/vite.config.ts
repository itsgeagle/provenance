import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { visualizer } from 'rollup-plugin-visualizer';

export default defineConfig({
  plugins: [
    react(),
    // Bundle analysis: emits dist/.report.html when ANALYZE=1 is set, or always
    // in CI / build mode. Reviewers can open this file to verify chunk separation
    // (e.g. /local chunk does not pull cohort-only imports).
    visualizer({
      filename: 'dist/.report.html',
      open: false,
      gzipSize: true,
      brotliSize: true,
    }),
  ],
  base: './',
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    // Route-based code-splitting is handled by React.lazy in App.tsx.
    // This rollupOptions block exists as documentation only; Vite handles
    // dynamic imports automatically.
    rollupOptions: {
      output: {
        // Ensure chunk names are stable so diff/review can track chunk identity.
        chunkFileNames: 'assets/[name]-[hash].js',
      },
    },
  },
});
