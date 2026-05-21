/**
 * API v1 — Hono app composition.
 *
 * Mounts auth and me routes under /api/v1.
 * Imported by api/start.ts which mounts this under '/' (preserving /healthz at root).
 */

import { Hono } from 'hono';
import { createAuthRouter } from './routes/auth.js';
import { createMeRouter } from './routes/me.js';

export function createV1App(): Hono {
  const app = new Hono();

  app.route('/auth', createAuthRouter());
  app.route('/me', createMeRouter());

  return app;
}
