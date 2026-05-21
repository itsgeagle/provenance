import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { getConfig } from '../config/index.js';
import { getLogger } from '../logging.js';

/**
 * Creates and returns the Hono application instance.
 * Exported separately so tests can call `app.fetch()` without binding a port.
 */
export function createApp(): Hono {
  const app = new Hono();

  app.get('/healthz', (c) => {
    return c.json({ status: 'ok' });
  });

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
