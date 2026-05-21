/**
 * GET /api/v1/me — returns the authenticated principal.
 *
 * Phase 2: session-only. Memberships array is empty (wired in Phase 5).
 * Phase 3 adds bearer-token resolution via the `resolvePrincipal` seam.
 *
 * Response shape (PRD §8.1):
 * {
 *   user: { id, email, display_name, is_superadmin, created_at, last_login_at },
 *   memberships: [],
 *   principal_kind: 'session' | 'token'
 *   // token field absent in Phase 2
 * }
 */

import { Hono } from 'hono';
import { resolvePrincipal } from '../../middleware/auth-session.js';

export function createMeRouter(): Hono {
  const router = new Hono();

  router.get('/', async (c) => {
    // resolvePrincipal is the structural seam: Phase 3 will extend it to also
    // try bearer tokens. The route itself doesn't change.
    const principal = await resolvePrincipal(c);

    if (principal === null) {
      const returnTo = encodeURIComponent(c.req.path);
      const loginUrl = `/api/v1/auth/google/start?return_to=${returnTo}`;
      return c.json(
        {
          error: {
            code: 'AUTH_REQUIRED',
            message: 'Authentication required',
            details: { login_url: loginUrl },
          },
        },
        401,
        { 'WWW-Authenticate': 'Cookie' },
      );
    }

    const { user, principal_kind } = principal;

    return c.json({
      user: {
        id: user.id,
        email: user.email,
        display_name: user.display_name,
        is_superadmin: user.is_superadmin,
        created_at: user.created_at.toISOString(),
        last_login_at: user.last_login_at !== null ? user.last_login_at.toISOString() : null,
      },
      memberships: [], // Phase 5 will populate this
      principal_kind,
    });
  });

  return router;
}
