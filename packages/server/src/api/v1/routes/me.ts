/**
 * GET /api/v1/me — returns the authenticated principal.
 *
 * Response shape (PRD §8.1):
 * {
 *   user: { id, email, display_name, is_superadmin, created_at, last_login_at },
 *   memberships: [],
 *   principal_kind: 'session' | 'token',
 *   token?: { id, label, scopes }  // present when principal_kind === 'token'
 * }
 *
 * Phase 2: session-only (no token field).
 * Phase 3: supports bearer tokens (token field included when principal_kind === 'token').
 */

import { Hono } from 'hono';
import { resolvePrincipal } from '../../middleware/auth-session.js';

export function createMeRouter(): Hono {
  const router = new Hono();

  router.get('/', async (c) => {
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

    const response: Record<string, any> = {
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
    };

    // If authenticated via token, include token info
    if (principal_kind === 'token') {
      const token = principal.token;
      const scopes = typeof token.scopes === 'string' ? JSON.parse(token.scopes) : token.scopes;
      response.token = {
        id: token.id,
        label: token.label,
        scopes,
      };
    }

    return c.json(response);
  });

  return router;
}
