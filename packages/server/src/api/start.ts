import { Hono } from 'hono';
import { getRequestListener } from '@hono/node-server';
import { createServer } from 'node:http';
import { getConfig } from '../config/index.js';
import { getLogger } from '../logging.js';
import { createV1App } from './v1/index.js';
import { requestId } from './middleware/request-id.js';
import { errorFormatter } from './middleware/error.js';
import { createMetricsRouter, metricsMiddleware } from './middleware/metrics.js';
import { resolveListenTarget, prepareSocket, makeWorldWritable } from './listen.js';
import { mountStatic } from './static.js';

/**
 * Creates and returns the Hono application instance.
 * Exported separately so tests can call `app.fetch()` without binding a port.
 *
 * Route layout:
 *   GET  /healthz        — liveness probe (root; not under /api/v1)
 *   *    /api/v1/**      — versioned API
 *   *    /**             — same-origin SPA static assets + fallback (last)
 *
 * Pipeline (outermost to innermost):
 *   requestId        — UUID on every request/response; child logger binding
 *   errorFormatter   — global onError handler (ApiError, ZodError, catch-all)
 *   authSessionMiddleware  — resolves principal (mounted in createV1App)
 *   initMembershipCache    — per-request membership cache (mounted in createV1App)
 *   [route-specific middlewares: rateLimit, requireAuth, audit]
 *   [route handler]
 */
export function createApp(): Hono {
  const app = new Hono();

  // Request ID must run first so it's available to errorFormatter.
  app.use('*', requestId);

  // Metrics middleware — records request counters + duration histograms.
  // Runs after requestId so the request is fully identified, before routes
  // so all requests (including 4xx/5xx) are counted.
  app.use('*', metricsMiddleware);

  // Global error handler — converts ApiError, ZodError, and unknown errors.
  app.onError(errorFormatter);

  app.get('/healthz', (c) => {
    return c.json({ status: 'ok' });
  });

  // /metrics — Prometheus exposition (protected by METRICS_AUTH_TOKEN).
  // Mounted at top level (not under /api/v1) to keep it off the public surface.
  app.route('/', createMetricsRouter());

  app.route('/api/v1', createV1App());

  // Same-origin SPA serving — mounted LAST so it never shadows /healthz,
  // /metrics, or /api/v1 (see api/static.ts for the prefix guard details).
  mountStatic(app, { publicDir: getConfig().PUBLIC_DIR });

  return app;
}

/**
 * Boots the HTTP server, listening on the env-configured target.
 * Called from the CLI entry point when running in `api` mode.
 *
 * When `SOCKET_PATH` is set, binds a Unix domain socket instead of a TCP
 * port — the EECS apphost's nginx proxies to us over that socket (TLS
 * terminates at the edge). The socket is made world-writable so nginx
 * (running as a different user) can connect to it.
 */
export function startApi(): void {
  const cfg = getConfig();
  const logger = getLogger();
  const app = createApp();

  const server = createServer(getRequestListener(app.fetch));
  const target = resolveListenTarget(cfg);

  if (target.kind === 'socket') {
    prepareSocket(target.path);
    server.listen(target.path, () => {
      makeWorldWritable(target.path);
      logger.info({ socket: target.path }, 'Server listening (unix socket)');
    });
  } else {
    server.listen(target.port, () => {
      logger.info({ port: target.port }, 'Server listening (tcp)');
    });
  }
}
