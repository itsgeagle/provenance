/**
 * Auth route integration tests.
 *
 * Uses withTestDb for DB isolation and FakeGoogleOAuthClient for network isolation.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { withTestDb } from '../../../../test/helpers/db.js';
import { _resetConfigForTest, _setConfigForTest } from '../../../config/index.js';
import { _resetLoggerForTest } from '../../../logging.js';
import { parseEnv } from '../../../config/env.js';
import { createAuthRouter } from './auth.js';
import { FakeGoogleOAuthClient } from '../../../../test/helpers/fake-google-client.js';
import type { GoogleOAuthClient } from '../../../auth/google.js';
import { users, sessions } from '../../../db/schema.js';
import { eq } from 'drizzle-orm';
import type { DrizzleDb } from '../../../db/client.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// ---------------------------------------------------------------------------
// Test env
// ---------------------------------------------------------------------------

const BASE_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  PUBLIC_BASE_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgres://user:pass@localhost:5432/provenance',
  OBJECT_STORAGE_ENDPOINT: 'http://localhost:9000',
  OBJECT_STORAGE_BUCKET: 'provenance',
  OBJECT_STORAGE_ACCESS_KEY_ID: 'minioadmin',
  OBJECT_STORAGE_SECRET_ACCESS_KEY: 'minioadmin',
  GOOGLE_OAUTH_CLIENT_ID: 'client-id',
  GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
  AUTH_ALLOWED_HOSTED_DOMAINS: '["berkeley.edu"]',
  AUTH_SUPERADMIN_EMAILS: '["superadmin@berkeley.edu"]',
  AUTH_COOKIE_SIGNING_SECRET: 'test-signing-secret-for-auth-route-tests-abcdef',
  SESSION_TTL_DAYS: '14',
};

beforeEach(() => {
  _resetConfigForTest();
  _resetLoggerForTest();
  _setConfigForTest(parseEnv(BASE_ENV));
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a test app that mounts auth routes with a FakeGoogleOAuthClient.
 * The client is injected via c.var before routes run.
 */
function makeApp(fakeClient: GoogleOAuthClient): Hono {
  const app = new Hono();
  // Inject the fake client.
  app.use('*', async (c, next) => {
    c.set('googleOAuthClient', fakeClient);
    await next();
  });
  app.route('/', createAuthRouter());
  return app;
}

/**
 * Extracts a named cookie value from a Set-Cookie header string.
 */
function extractCookieValue(setCookieHeader: string | null, name: string): string | null {
  if (setCookieHeader === null) return null;
  // Set-Cookie headers may be comma-separated for multiple cookies.
  for (const part of setCookieHeader.split(',')) {
    const first = part.trim().split(';')[0]?.trim() ?? '';
    if (first.startsWith(`${name}=`)) {
      return first.slice(name.length + 1);
    }
  }
  return null;
}

/**
 * Performs the start flow and returns the oauth cookie value.
 */
async function doStart(
  app: Hono,
  returnTo = '/',
): Promise<{ oauthCookie: string; location: string }> {
  const res = await app.fetch(
    new Request(`http://localhost/google/start?return_to=${encodeURIComponent(returnTo)}`, {
      method: 'POST',
    }),
  );
  const location = res.headers.get('location') ?? '';
  const setCookieHeader = res.headers.get('set-cookie') ?? '';
  const oauthCookie = extractCookieValue(setCookieHeader, '__Host-prov_oauth') ?? '';
  return { oauthCookie, location };
}

/**
 * Performs the callback flow with a given oauth cookie + code + state.
 */
async function doCallback(
  app: Hono,
  oauthCookie: string,
  code: string,
  state: string,
): Promise<Response> {
  return app.fetch(
    new Request(
      `http://localhost/google/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
      {
        headers: {
          Cookie: `__Host-prov_oauth=${oauthCookie}`,
        },
      },
    ),
  );
}

// ---------------------------------------------------------------------------
// POST /google/start — happy path
// ---------------------------------------------------------------------------

describe('POST /google/start', () => {
  it('happy path: 302 to Google with correct params; oauth cookie set', async () => {
    const fake = new FakeGoogleOAuthClient({ state: 'test-state', codeVerifier: 'test-cv' });
    const app = makeApp(fake);

    const res = await app.fetch(
      new Request('http://localhost/google/start?return_to=%2Fdashboard', { method: 'POST' }),
    );

    expect(res.status).toBe(302);
    const location = res.headers.get('location') ?? '';
    expect(location).toContain('accounts.google.com');
    expect(location).toContain('state=test-state');
    expect(location).toContain('code_challenge_method=S256');
    expect(location).toContain('hd=berkeley.edu');
    expect(location).toContain('redirect_uri=');

    const setCookieHeader = res.headers.get('set-cookie') ?? '';
    expect(setCookieHeader).toContain('__Host-prov_oauth');
    expect(setCookieHeader).toContain('HttpOnly');
    expect(setCookieHeader).toContain('Secure');
    expect(setCookieHeader).toContain('SameSite=Lax');
  });

  it('default return_to = / when not provided', async () => {
    const fake = new FakeGoogleOAuthClient();
    const app = makeApp(fake);
    const res = await app.fetch(new Request('http://localhost/google/start', { method: 'POST' }));
    expect(res.status).toBe(302);
  });
});

// ---------------------------------------------------------------------------
// POST /google/start — invalid return_to
// ---------------------------------------------------------------------------

describe('POST /google/start — invalid return_to', () => {
  it('rejects absolute URL with BAD_REQUEST_RETURN_TO_INVALID', async () => {
    const fake = new FakeGoogleOAuthClient();
    const app = makeApp(fake);

    const res = await app.fetch(
      new Request(
        'http://localhost/google/start?return_to=' +
          encodeURIComponent('https://evil.com/steal'),
        { method: 'POST' },
      ),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('BAD_REQUEST_RETURN_TO_INVALID');
  });

  it('rejects protocol-relative URL //evil.com', async () => {
    const fake = new FakeGoogleOAuthClient();
    const app = makeApp(fake);
    const res = await app.fetch(
      new Request(
        'http://localhost/google/start?return_to=' + encodeURIComponent('//evil.com/'),
        { method: 'POST' },
      ),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('BAD_REQUEST_RETURN_TO_INVALID');
  });
});

// ---------------------------------------------------------------------------
// GET /google/callback — state mismatch
// ---------------------------------------------------------------------------

describe('GET /google/callback — state mismatch', () => {
  it('returns 400 AUTH_OAUTH_STATE_MISMATCH when state does not match', async () => {
    const fake = new FakeGoogleOAuthClient({ state: 'correct-state' });
    const app = makeApp(fake);

    const { oauthCookie } = await doStart(app, '/');

    const res = await doCallback(app, oauthCookie, 'code', 'wrong-state');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('AUTH_OAUTH_STATE_MISMATCH');
  });

  it('returns 400 AUTH_OAUTH_STATE_MISMATCH when oauth cookie is absent', async () => {
    const fake = new FakeGoogleOAuthClient();
    const app = makeApp(fake);
    const res = await app.fetch(
      new Request('http://localhost/google/callback?code=c&state=s'),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('AUTH_OAUTH_STATE_MISMATCH');
  });
});

// ---------------------------------------------------------------------------
// GET /google/callback — token exchange failure
// ---------------------------------------------------------------------------

describe('GET /google/callback — token exchange failure', () => {
  it('returns 502 AUTH_OAUTH_CODE_EXCHANGE_FAILED when client throws', async () => {
    const fake = new FakeGoogleOAuthClient({ state: 'st', shouldThrow: true });
    const app = makeApp(fake);

    const { oauthCookie } = await doStart(app, '/');
    const res = await doCallback(app, oauthCookie, 'code', 'st');
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.code).toBe('AUTH_OAUTH_CODE_EXCHANGE_FAILED');
  });
});

// ---------------------------------------------------------------------------
// GET /google/callback — domain not allowed
// ---------------------------------------------------------------------------

describe('GET /google/callback — domain gates', () => {
  it('returns 403 AUTH_DOMAIN_NOT_ALLOWED when hd is not in allowed domains', async () => {
    await withTestDb(async (_db) => {
      const fake = new FakeGoogleOAuthClient({ state: 'st' });
      fake.setClaims({
        sub: 'sub-1',
        email: 'student@other.edu',
        email_verified: true,
        hd: 'other.edu',
        name: 'Student',
      });
      const app = makeApp(fake);

      const { oauthCookie } = await doStart(app, '/');
      const res = await doCallback(app, oauthCookie, 'code', 'st');
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.code).toBe('AUTH_DOMAIN_NOT_ALLOWED');
    });
  });

  it('returns 403 AUTH_DOMAIN_NOT_ALLOWED when hd is absent', async () => {
    await withTestDb(async (_db) => {
      const fake = new FakeGoogleOAuthClient({ state: 'st' });
      fake.setClaims({
        sub: 'sub-1',
        email: 'student@gmail.com',
        email_verified: true,
        // hd absent
      });
      const app = makeApp(fake);

      const { oauthCookie } = await doStart(app, '/');
      const res = await doCallback(app, oauthCookie, 'code', 'st');
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.code).toBe('AUTH_DOMAIN_NOT_ALLOWED');
    });
  });

  it('returns 403 AUTH_EMAIL_NOT_VERIFIED when email_verified is false', async () => {
    await withTestDb(async (_db) => {
      const fake = new FakeGoogleOAuthClient({ state: 'st' });
      fake.setClaims({
        sub: 'sub-1',
        email: 'student@berkeley.edu',
        email_verified: false,
        hd: 'berkeley.edu',
      });
      const app = makeApp(fake);

      const { oauthCookie } = await doStart(app, '/');
      const res = await doCallback(app, oauthCookie, 'code', 'st');
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.code).toBe('AUTH_EMAIL_NOT_VERIFIED');
    });
  });
});

// ---------------------------------------------------------------------------
// DB-injected integration tests using vi.mock
// ---------------------------------------------------------------------------

// vi.mock intercepts getDb() so routes use the testcontainers DB.
// vi.mock is hoisted by vitest to the top of the compiled module.
// We pass the DB handle via a module-level variable that the mock reads.
let _testDb: DrizzleDb | null = null;

vi.mock('../../../db/client.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../db/client.js')>();
  return {
    ...original,
    getDb: () => {
      if (_testDb !== null) return _testDb;
      return original.getDb();
    },
  };
});

describe('GET /google/callback — new user (DB injected)', () => {
  it('302 to return_to; user row created; session cookie set; session row in DB', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const fake = new FakeGoogleOAuthClient({ state: 'st' });
        fake.setClaims({
          sub: 'sub-new-user',
          email: 'newstudent@berkeley.edu',
          email_verified: true,
          hd: 'berkeley.edu',
          name: 'New Student',
        });
        const app = makeApp(fake);

        const { oauthCookie } = await doStart(app, '/dashboard');
        const res = await doCallback(app, oauthCookie, 'code', 'st');

        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toBe('/dashboard');

        // Session cookie set.
        const setCookieHeader = res.headers.get('set-cookie') ?? '';
        expect(setCookieHeader).toContain('__Host-prov_sess');
        expect(setCookieHeader).toContain('HttpOnly');

        // User row created.
        const userRows = await db
          .select()
          .from(users)
          .where(eq(users.google_subject, 'sub-new-user'));
        expect(userRows).toHaveLength(1);
        expect(userRows[0]!.email).toBe('newstudent@berkeley.edu');
        expect(userRows[0]!.display_name).toBe('New Student');
        expect(userRows[0]!.is_superadmin).toBe(false);
        expect(userRows[0]!.last_login_at).not.toBeNull();

        // Session row in DB.
        const sessionCookieValue =
          extractCookieValue(setCookieHeader, '__Host-prov_sess') ?? '';
        expect(sessionCookieValue).toBeTruthy();

        const sessionRows = await db
          .select()
          .from(sessions)
          .where(eq(sessions.id, sessionCookieValue));
        expect(sessionRows).toHaveLength(1);
        expect(sessionRows[0]!.user_id).toBe(userRows[0]!.id);
      } finally {
        _testDb = null;
      }
    });
  });
});

describe('GET /google/callback — existing user (DB injected)', () => {
  it('302; user last_login_at updated; no duplicate user row', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        // Pre-create the user.
        await db
          .insert(users)
          .values({
            google_subject: 'sub-existing-user',
            email: 'existing@berkeley.edu',
            display_name: 'Old Name',
            is_superadmin: false,
          })
          .returning();
        await new Promise((r) => setTimeout(r, 50));

        const fake = new FakeGoogleOAuthClient({ state: 'st' });
        fake.setClaims({
          sub: 'sub-existing-user',
          email: 'existing@berkeley.edu',
          email_verified: true,
          hd: 'berkeley.edu',
          name: 'New Name',
        });
        const app = makeApp(fake);

        const { oauthCookie } = await doStart(app, '/');
        const res = await doCallback(app, oauthCookie, 'code', 'st');
        expect(res.status).toBe(302);

        // Only one user row.
        const userRows = await db
          .select()
          .from(users)
          .where(eq(users.google_subject, 'sub-existing-user'));
        expect(userRows).toHaveLength(1);

        // last_login_at updated (either newly set or bumped).
        const updated = userRows[0]!;
        expect(updated.last_login_at).not.toBeNull();

        // display_name updated.
        expect(updated.display_name).toBe('New Name');
      } finally {
        _testDb = null;
      }
    });
  });
});

describe('GET /google/callback — superadmin email (DB injected)', () => {
  it('sets is_superadmin=true for email in AUTH_SUPERADMIN_EMAILS', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const fake = new FakeGoogleOAuthClient({ state: 'st' });
        fake.setClaims({
          sub: 'sub-superadmin',
          email: 'superadmin@berkeley.edu',
          email_verified: true,
          hd: 'berkeley.edu',
          name: 'Super Admin',
        });
        const app = makeApp(fake);

        const { oauthCookie } = await doStart(app, '/');
        const res = await doCallback(app, oauthCookie, 'code', 'st');
        expect(res.status).toBe(302);

        const userRows = await db
          .select()
          .from(users)
          .where(eq(users.google_subject, 'sub-superadmin'));
        expect(userRows).toHaveLength(1);
        expect(userRows[0]!.is_superadmin).toBe(true);
      } finally {
        _testDb = null;
      }
    });
  });
});

// ---------------------------------------------------------------------------
// POST /logout
// ---------------------------------------------------------------------------

describe('POST /logout (DB injected)', () => {
  it('deletes session row and clears cookie; returns 204', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const fake = new FakeGoogleOAuthClient({ state: 'st' });
        fake.setClaims({
          sub: 'sub-logout-user',
          email: 'logout@berkeley.edu',
          email_verified: true,
          hd: 'berkeley.edu',
        });
        const app = makeApp(fake);

        // Login first.
        const { oauthCookie } = await doStart(app, '/');
        const callbackRes = await doCallback(app, oauthCookie, 'code', 'st');
        expect(callbackRes.status).toBe(302);

        // Extract session cookie.
        const setCookieHeader = callbackRes.headers.get('set-cookie') ?? '';
        const sessionId = extractCookieValue(setCookieHeader, '__Host-prov_sess') ?? '';
        expect(sessionId).toBeTruthy();

        // Verify session exists.
        const beforeRows = await db.select().from(sessions).where(eq(sessions.id, sessionId));
        expect(beforeRows).toHaveLength(1);

        // Logout.
        const logoutRes = await app.fetch(
          new Request('http://localhost/logout', {
            method: 'POST',
            headers: { Cookie: `__Host-prov_sess=${sessionId}` },
          }),
        );
        expect(logoutRes.status).toBe(204);

        // Session row deleted.
        const afterRows = await db.select().from(sessions).where(eq(sessions.id, sessionId));
        expect(afterRows).toHaveLength(0);

        // Cookie cleared.
        const logoutCookieHeader = logoutRes.headers.get('set-cookie') ?? '';
        expect(logoutCookieHeader).toContain('Max-Age=0');
      } finally {
        _testDb = null;
      }
    });
  });
});
