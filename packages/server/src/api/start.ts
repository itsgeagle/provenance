import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { getConfig } from '../config/index.js';
import { getLogger } from '../logging.js';
import { createV1App } from './v1/index.js';

/**
 * Creates and returns the Hono application instance.
 * Exported separately so tests can call `app.fetch()` without binding a port.
 *
 * Route layout:
 *   GET  /healthz        — liveness probe (root; not under /api/v1)
 *   *    /api/v1/**      — versioned API
 */
export function createApp(): Hono {
  const app = new Hono();

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
