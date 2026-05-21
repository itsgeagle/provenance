/**
 * Auth routes: OAuth start/callback + logout.
 *
 * POST /api/v1/auth/google/start  — initiates Google OAuth PKCE flow
 * GET  /api/v1/auth/google/callback — handles Google redirect
 * POST /api/v1/auth/logout         — invalidates session
 *
 * The GoogleOAuthClient is injected via `c.var.googleOAuthClient` so tests
 * can provide a FakeGoogleOAuthClient without network access.
 * In production the real client is injected by a tiny middleware below.
 *
 * Design notes:
 * - Routes do NOT use a global error handler (coming in Phase 4). They handle
 *   ApiError inline and return JSON directly.
 * - User upsert uses an explicit SELECT then INSERT/UPDATE — not an ON CONFLICT
 *   — to avoid requiring a unique constraint on google_subject beyond what the
 *   schema already provides. The schema DOES have a UNIQUE on google_subject so
 *   a race at first-ever login would fail gracefully (postgres throws, we 502).
 *   For the v3 scale this is acceptable; Phase 9+ can add ON CONFLICT if needed.
 */

import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { users } from '../../../db/schema.js';
import { getDb } from '../../../db/client.js';
import { getConfig } from '../../../config/index.js';
import {
  setOAuthStateCookie,
  getOAuthStateCookie,
  clearOAuthStateCookie,
  setSessionCookie,
} from '../../../auth/cookies.js';
import { createSession, sessionExpiresAt } from '../../../auth/sessions.js';
import { getRealGoogleOAuthClient, type GoogleOAuthClient } from '../../../auth/google.js';
import { Errors } from '../errors.js';

// ---------------------------------------------------------------------------
// Hono context variable for the OAuth client
// ---------------------------------------------------------------------------

declare module 'hono' {
  interface ContextVariableMap {
    googleOAuthClient: GoogleOAuthClient;
  }
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if `returnTo` is a valid same-origin path:
 * - starts with '/'
 * - is not empty beyond '/'
 * - does not contain a scheme or host (no '://' or leading '//')
 */
function isValidReturnTo(returnTo: string): boolean {
  if (!returnTo.startsWith('/')) return false;
  if (returnTo.startsWith('//')) return false; // protocol-relative URL
  if (returnTo.includes('://')) return false; // absolute URL
  return true;
}

// ---------------------------------------------------------------------------
// Route factory (accepts GoogleOAuthClient for testability)
// ---------------------------------------------------------------------------

export function createAuthRouter(): Hono {
  const router = new Hono();

  // Inject the real client on every request in production.
  // Tests override this by injecting their fake client before calling fetch.
  router.use('*', async (c, next) => {
    // Only set if not already injected (tests inject a fake).
    if (c.var.googleOAuthClient === undefined) {
      c.set('googleOAuthClient', getRealGoogleOAuthClient());
    }
    await next();
  });

  // -------------------------------------------------------------------------
  // POST /auth/google/start
  // -------------------------------------------------------------------------

  router.post('/google/start', async (c) => {
    const cfg = getConfig();
    const returnTo = c.req.query('return_to') ?? '/';

    if (!isValidReturnTo(returnTo)) {
      const err = Errors.badReturnTo();
      return c.json(err.toBody(), err.status as 400);
    }

    const client = c.var.googleOAuthClient;
    const { state, codeVerifier } = client.generatePkceParams();

    const redirectUri = `${cfg.PUBLIC_BASE_URL}/api/v1/auth/google/callback`;
    const authorizeUrl = client.createAuthorizeUrl({ state, codeVerifier, redirectUri });

    setOAuthStateCookie(c, { state, codeVerifier, returnTo });

    return c.redirect(authorizeUrl, 302);
  });

  // -------------------------------------------------------------------------
  // GET /auth/google/callback
  // -------------------------------------------------------------------------

  router.get('/google/callback', async (c) => {
    const cfg = getConfig();
    const db = getDb();

    // Read and immediately clear the OAuth state cookie (single-use).
    const oauthState = getOAuthStateCookie(c);
    clearOAuthStateCookie(c);

    const code = c.req.query('code');
    const stateParam = c.req.query('state');

    if (oauthState === null || stateParam !== oauthState.state) {
      const err = Errors.oauthStateMismatch();
      return c.json(err.toBody(), err.status as 400);
    }

    if (code === undefined) {
      const err = Errors.oauthStateMismatch();
      return c.json(err.toBody(), err.status as 400);
    }

    const redirectUri = `${cfg.PUBLIC_BASE_URL}/api/v1/auth/google/callback`;
    const client = c.var.googleOAuthClient;

    // Exchange code for tokens + decode ID token.
    let claims: Awaited<ReturnType<GoogleOAuthClient['exchangeCodeAndVerify']>>;
    try {
      claims = await client.exchangeCodeAndVerify({
        code,
        codeVerifier: oauthState.codeVerifier,
        redirectUri,
      });
    } catch (e) {
      const err = Errors.oauthCodeExchangeFailed(e instanceof Error ? e.message : undefined);
      return c.json(err.toBody(), err.status as 502);
    }

    // Enforce domain gate.
    const domainOk =
      claims.hd !== undefined && cfg.AUTH_ALLOWED_HOSTED_DOMAINS.includes(claims.hd);
    if (!domainOk) {
      const err = Errors.domainNotAllowed();
      return c.json(err.toBody(), err.status as 403);
    }

    // Enforce email_verified gate.
    if (!claims.email_verified) {
      const err = Errors.emailNotVerified();
      return c.json(err.toBody(), err.status as 403);
    }

    // Look up or create the user.
    const existingRows = await db
      .select()
      .from(users)
      .where(eq(users.google_subject, claims.sub))
      .limit(1);

    let userId: string;

    if (existingRows.length > 0 && existingRows[0] !== undefined) {
      // Found — update mutable fields.
      const existing = existingRows[0];
      userId = existing.id;
      await db
        .update(users)
        .set({
          last_login_at: new Date(),
          display_name: claims.name ?? existing.display_name,
          email: claims.email,
        })
        .where(eq(users.id, userId));
    } else {
      // Not found — create a new user.
      const isSuperadmin = cfg.AUTH_SUPERADMIN_EMAILS.includes(claims.email);
      const inserted = await db
        .insert(users)
        .values({
          google_subject: claims.sub,
          email: claims.email,
          display_name: claims.name ?? '',
          is_superadmin: isSuperadmin,
          last_login_at: new Date(),
        })
        .returning({ id: users.id });

      const newUser = inserted[0];
      if (newUser === undefined) {
        throw new Error('User insert returned no rows');
      }
      userId = newUser.id;

      // TODO(phase-6): activate pending invitations for this email address.
      // This is where the invitation activation hook will go after the
      // pending_invitations table is fully wired in Phase 6.
    }

    // Create session.
    const expiresAt = sessionExpiresAt(cfg.SESSION_TTL_DAYS);
    const ip = c.req.header('x-forwarded-for') ?? null;
    const userAgent = c.req.header('user-agent') ?? null;

    const sessionId = await createSession(db, {
      userId,
      expiresAt,
      ip,
      userAgent,
    });

    // Set session cookie.
    const maxAgeSec = cfg.SESSION_TTL_DAYS * 24 * 60 * 60;
    setSessionCookie(c, sessionId, maxAgeSec);

    // Redirect to return_to.
    const returnTo = oauthState.returnTo;
    const destination = returnTo.startsWith('/') ? returnTo : '/';
    return c.redirect(destination, 302);
  });

  // -------------------------------------------------------------------------
  // POST /auth/logout
  // -------------------------------------------------------------------------

  router.post('/logout', async (c) => {
    // Import inline to avoid circular dependency with middleware.
    const { getSessionCookie, clearSessionCookie } = await import('../../../auth/cookies.js');
    const { deleteSession } = await import('../../../auth/sessions.js');

    const sessionId = getSessionCookie(c);
    if (sessionId !== undefined) {
      try {
        await deleteSession(getDb(), sessionId);
      } catch {
        // Session may not exist; still clear the cookie.
      }
    }
    clearSessionCookie(c);
    return c.body(null, 204);
  });

  return router;
}
