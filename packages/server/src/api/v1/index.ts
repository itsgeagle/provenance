/**
 * API v1 — Hono app composition.
 *
 * Mounts auth and me routes under /api/v1.
 * Imported by api/start.ts which mounts this under '/api/v1'.
 *
 * Route order: /me/tokens is mounted before /me so the more-specific prefix
 * is registered first and cannot be shadowed by the broader /me handler.
 *
 * Pipeline established here (applies to all v1 routes):
 *   authSessionMiddleware  — resolves bearer/session principal → c.var.principal
 *   initMembershipCache    — initializes empty per-request membership cache
 *
 * Per-route middleware composition example (for future phases):
 *
 *   router.post('/semesters/:id/config',
 *     rateLimit('write.config'),
 *     requireAuth({ action: 'write', target: (c) => ({ semesterId: c.req.param('id') }) }),
 *     audit('heuristic_config.commit', 'semester', (c) => c.req.param('id')),
 *     handler,
 *   );
 *
 * The three middleware factory calls give a new endpoint:
 *   - Rate limiting (per principal, per route class)
 *   - Authorization (action + semester-scoped membership check)
 *   - Audit logging (fire-and-forget row on 2xx)
 */

import { Hono } from 'hono';
import { createAuthRouter } from './routes/auth.js';
import { createMeRouter } from './routes/me.js';
import { createMeTokensRouter } from './routes/me-tokens.js';
import { authSessionMiddleware } from '../middleware/auth-session.js';
import { initMembershipCache } from '../../auth/membership-cache.js';

export function createV1App(): Hono {
  const app = new Hono();

  // Auth resolution runs before all v1 routes.
  app.use('*', authSessionMiddleware);

  // Membership cache is initialized per-request so requireAuth can call
  // findMembership() without hitting the DB more than once per semester.
  app.use('*', initMembershipCache);

  app.route('/auth', createAuthRouter());
  // Mount /me/tokens before /me to prevent prefix shadowing.
  app.route('/me/tokens', createMeTokensRouter());
  app.route('/me', createMeRouter());

  return app;
}
