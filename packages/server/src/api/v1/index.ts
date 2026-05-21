/**
 * API v1 — Hono app composition.
 *
 * Mounts auth and me routes under /api/v1.
 * Imported by api/start.ts which mounts this under '/' (preserving /healthz at root).
 *
 * Route order: /me/tokens is mounted before /me so the more-specific prefix
 * is registered first and cannot be shadowed by the broader /me handler.
 */

import { Hono } from 'hono';
import { createAuthRouter } from './routes/auth.js';
import { createMeRouter } from './routes/me.js';
import { createMeTokensRouter } from './routes/me-tokens.js';

export function createV1App(): Hono {
  const app = new Hono();

  app.route('/auth', createAuthRouter());
  // Mount /me/tokens before /me to prevent prefix shadowing.
  app.route('/me/tokens', createMeTokensRouter());
  app.route('/me', createMeRouter());

  return app;
}
