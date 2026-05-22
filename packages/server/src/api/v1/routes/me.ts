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
import { getDb } from '../../../db/client.js';
import * as structureService from '../../../services/structure.js';
import type { TokenScopes } from '../../../auth/tokens.js';

// ---------------------------------------------------------------------------
// Response shape
// ---------------------------------------------------------------------------

interface UserSummary {
  id: string;
  email: string;
  display_name: string | null;
  is_superadmin: boolean;
  created_at: string;
  last_login_at: string | null;
}

interface MembershipSummary {
  semester_id: string;
  semester_slug: string;
  course_slug: string;
  role: 'admin' | 'grader';
  granted_at: string;
}

type MeResponse =
  | {
      user: UserSummary;
      memberships: MembershipSummary[];
      principal_kind: 'session';
    }
  | {
      user: UserSummary;
      memberships: MembershipSummary[];
      principal_kind: 'token';
      token: { id: string; label: string; scopes: TokenScopes };
    };

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function createMeRouter(): Hono {
  const router = new Hono();

  router.get('/', async (c) => {
    const result = await resolvePrincipal(c);

    if (result.kind === 'invalid_bearer') {
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
        { 'WWW-Authenticate': 'Bearer' },
      );
    }

    if (result.kind === 'none') {
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

    const { principal } = result;
    const { user, principal_kind } = principal;

    const userSummary: UserSummary = {
      id: user.id,
      email: user.email,
      display_name: user.display_name,
      is_superadmin: user.is_superadmin,
      created_at: user.created_at.toISOString(),
      last_login_at: user.last_login_at !== null ? user.last_login_at.toISOString() : null,
    };

    // Fetch user's memberships from database
    const db = getDb();
    const membershipRows = await structureService.getUserMemberships(db, user.id);
    const memberships: MembershipSummary[] = membershipRows.map((m) => ({
      semester_id: m.semester_id,
      semester_slug: m.semester_slug,
      course_slug: m.course_slug,
      role: m.role as 'admin' | 'grader',
      granted_at: m.granted_at.toISOString(),
    }));

    if (principal_kind === 'token') {
      const token = principal.token;
      const scopes: TokenScopes =
        typeof token.scopes === 'string'
          ? (JSON.parse(token.scopes) as TokenScopes)
          : (token.scopes as TokenScopes);
      const response: MeResponse = {
        user: userSummary,
        memberships,
        principal_kind: 'token',
        token: { id: token.id, label: token.label, scopes },
      };
      return c.json(response);
    }

    const response: MeResponse = {
      user: userSummary,
      memberships,
      principal_kind: 'session',
    };
    return c.json(response);
  });

  return router;
}
