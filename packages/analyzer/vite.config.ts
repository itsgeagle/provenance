import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { visualizer } from 'rollup-plugin-visualizer';

// Dev proxy target. Overridable via VITE_API_PROXY_TARGET so contributors can
// point the dev UI at a remote staging server without editing vite.config.ts.
// Default matches packages/server's PORT default of 3000 (config/env.ts).
const API_PROXY_TARGET = process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [
    react(),
    // Bundle analysis: emits dist/.report.html ONLY when ANALYZE=1 is set.
    // It must NOT be emitted in a normal `vite build` — the production image
    // copies dist/ into the server's public dir, and the report would then be
    // served pre-auth at GET /.report.html, leaking the module graph. Run
    // `ANALYZE=1 npm run build --workspace=packages/analyzer` to generate it
    // locally to verify chunk separation (e.g. /local chunk stays lean).
    ...(process.env.ANALYZE
      ? [
          visualizer({
            filename: 'dist/.report.html',
            open: false,
            gzipSize: true,
            brotliSize: true,
          }),
        ]
      : []),
  ],
  base: './',
  server: {
    // The proxy is the same-origin trick that keeps __Host- session cookies
    // working in dev: the browser only ever sees the Vite dev origin, the
    // cookie is scoped to that origin, and Vite forwards the Cookie header
    // to the backend on every request. Without this, a separate frontend
    // origin (e.g. localhost:5173) plus a backend on localhost:3000 would
    // need CORS + SameSite=None + Secure dance to ship session cookies, and
    // __Host- prefix would refuse to set at all.
    proxy: {
      '/api': {
        target: API_PROXY_TARGET,
        // changeOrigin: true rewrites the upstream Host header to match the
        // target. The server's request logs then show the real backend host
        // instead of localhost:5173, and any host-aware logic on the server
        // (e.g. redirect URL construction) sees a coherent value.
        changeOrigin: true,
        // secure: false lets contributors point at HTTPS targets with
        // self-signed certs (e.g. a staging tunnel) without TLS verification
        // errors. Production traffic doesn't flow through this proxy.
        secure: false,
        configure: (proxy) => {
          // Without this, a backend that's not running shows up as an opaque
          // 504/empty response in the browser. Logging the error makes the
          // failure mode obvious in the dev console.
          proxy.on('error', (err, req) => {
            // eslint-disable-next-line no-console
            console.error(`[vite proxy] ${req.method} ${req.url} -> ${err.message}`);
          });
        },
      },
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
