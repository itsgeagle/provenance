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
import { eq } from 'drizzle-orm';
import { resolvePrincipal } from '../../middleware/auth-session.js';
import { getDb } from '../../../db/client.js';
import { users } from '../../../db/schema.js';
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
  protected: boolean;
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

interface ViewAsSummary {
  user: {
    id: string;
    email: string;
    display_name: string | null;
  };
  started_at: string;
}

type MeResponse =
  | {
      user: UserSummary;
      memberships: MembershipSummary[];
      principal_kind: 'session';
      view_as: ViewAsSummary | null;
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
      protected: user.protected,
      created_at: user.created_at.toISOString(),
      last_login_at: user.last_login_at !== null ? user.last_login_at.toISOString() : null,
    };

    const db = getDb();

    // View-as (V45): when a superadmin is impersonating, /me returns the
    // TARGET user's memberships (so the frontend's semester switcher and
    // route gates reflect what the target would see) and surfaces a
    // `view_as` block carrying the target's identity for the banner.
    // The principal's own `user` field is still the superadmin so the
    // banner can show "viewing as X" attributed to the actual operator.
    const viewAs = principal.principal_kind === 'session' ? principal.viewAs : undefined;
    const membershipsUserId = viewAs !== undefined ? viewAs.userId : user.id;

    const membershipRows = await structureService.getUserMemberships(db, membershipsUserId);
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

    let viewAsSummary: ViewAsSummary | null = null;
    if (viewAs !== undefined) {
      const targetRows = await db
        .select({ id: users.id, email: users.email, display_name: users.display_name })
        .from(users)
        .where(eq(users.id, viewAs.userId))
        .limit(1);
      const target = targetRows[0];
      if (target !== undefined) {
        viewAsSummary = {
          user: {
            id: target.id,
            email: target.email,
            display_name: target.display_name,
          },
          started_at: viewAs.startedAt.toISOString(),
        };
      }
    }

    const response: MeResponse = {
      user: userSummary,
      memberships,
      principal_kind: 'session',
      view_as: viewAsSummary,
    };
    return c.json(response);
  });

  return router;
}
