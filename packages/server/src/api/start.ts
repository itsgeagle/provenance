import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { getConfig } from '../config/index.js';
import { getLogger } from '../logging.js';
import { createV1App } from './v1/index.js';
import { requestId } from './middleware/request-id.js';
import { errorFormatter } from './middleware/error.js';

/**
 * Creates and returns the Hono application instance.
 * Exported separately so tests can call `app.fetch()` without binding a port.
 *
 * Route layout:
 *   GET  /healthz        — liveness probe (root; not under /api/v1)
 *   *    /api/v1/**      — versioned API
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

  // Global error handler — converts ApiError, ZodError, and unknown errors.
  app.onError(errorFormatter);

  app.get('/healthz', (c) => {
    return c.json({ status: 'ok' });
  });

  app.route('/api/v1', createV1App());

  return app;
}

/**
 * Boots the HTTP server, listening on the env-configured port.
 * Called from the CLI entry point when running in `api` mode.
 */
export function startApi(): void {
  const cfg = getConfig();
  const logger = getLogger();
  const app = createApp();

  serve(
    {
      fetch: app.fetch,
      port: cfg.PORT,
    },
    (info) => {
      logger.info({ port: info.port }, 'Server listening');
    },
  );
}
