/**
 * Google OAuth 2.0 client — arctic wrapper + testability seam.
 *
 * The `GoogleOAuthClient` interface is the seam between route handlers and
 * the real Google OIDC flow. Tests inject a `FakeGoogleOAuthClient` that
 * returns pre-baked payloads; production uses `RealGoogleOAuthClient`.
 *
 * `RealGoogleOAuthClient` uses arctic v3:
 * - `Google.createAuthorizationURL(state, codeVerifier, scopes)` → URL
 * - `Google.validateAuthorizationCode(code, codeVerifier)` → OAuth2Tokens
 * - `verifyIdToken(tokens.idToken(), audience)` → cryptographically verified claims
 *
 * The ID token is verified against Google's JWKs using Node's built-in
 * `node:crypto` (RS256). See `verify-id-token.ts` and `jwks.ts` for details.
 */

import { Google, generateState, generateCodeVerifier } from 'arctic';
import { getConfig } from '../config/index.js';
import { verifyIdToken, type VerifyIdTokenOptions } from './verify-id-token.js';
import type { JwkSet } from './jwks.js';

// ---------------------------------------------------------------------------
// Public seam interface
// ---------------------------------------------------------------------------

/**
 * Verified ID-token claims returned after a successful code exchange.
 * Arctic's `decodeIdToken` returns `object`; we narrow to the claims we need.
 */
export interface IdTokenClaims {
  sub: string;
  email: string;
  email_verified: boolean;
  hd?: string | undefined;
  name?: string | undefined;
}

export interface GoogleOAuthClient {
  /**
   * Generates a state nonce and code verifier for a new login attempt.
   * Returns them so the caller can store them (e.g. in a cookie).
   */
  generatePkceParams(): { state: string; codeVerifier: string };

  /**
   * Builds the Google authorize URL with PKCE + state + hd hint.
   * Does NOT store state — caller is responsible for persistence.
   */
  createAuthorizeUrl(args: { state: string; codeVerifier: string; redirectUri: string }): string;

  /**
   * Exchanges the authorization code for tokens and decodes the ID token.
   * Returns the verified ID-token claims.
   * Throws on network failure or if the ID token is absent/malformed.
   */
  exchangeCodeAndVerify(args: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<IdTokenClaims>;
}

// ---------------------------------------------------------------------------
// Real implementation (uses arctic + getConfig())
// ---------------------------------------------------------------------------

export class RealGoogleOAuthClient implements GoogleOAuthClient {
  /**
   * Optional JWKs fetcher override — for integration tests only.
   * Production callers always use the module-level `getGoogleJwks` default.
   */
  private readonly _verifyOpts: VerifyIdTokenOptions;

  constructor(opts: { fetchJwks?: () => Promise<JwkSet> } = {}) {
    // Conditionally include fetchJwks to satisfy exactOptionalPropertyTypes:
    // the property must be absent (not undefined) when not provided.
    this._verifyOpts = opts.fetchJwks !== undefined ? { fetchJwks: opts.fetchJwks } : {};
  }

  private makeGoogle(redirectUri: string): Google {
    const cfg = getConfig();
    return new Google(cfg.GOOGLE_OAUTH_CLIENT_ID, cfg.GOOGLE_OAUTH_CLIENT_SECRET, redirectUri);
  }

  generatePkceParams(): { state: string; codeVerifier: string } {
    return {
      state: generateState(),
      codeVerifier: generateCodeVerifier(),
    };
  }

  createAuthorizeUrl(args: { state: string; codeVerifier: string; redirectUri: string }): string {
    const google = this.makeGoogle(args.redirectUri);
    const url = google.createAuthorizationURL(args.state, args.codeVerifier, [
      'openid',
      'email',
      'profile',
    ]);
    // hd is a login hint to Google's account picker (not a security boundary).
    // We enforce domain in exchangeCodeAndVerify.
    const cfg = getConfig();
    url.searchParams.set('hd', cfg.AUTH_ALLOWED_HOSTED_DOMAINS[0] ?? 'berkeley.edu');
    return url.toString();
  }

  async exchangeCodeAndVerify(args: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<IdTokenClaims> {
    const cfg = getConfig();
    const google = this.makeGoogle(args.redirectUri);
    const tokens = await google.validateAuthorizationCode(args.code, args.codeVerifier);
    const idToken = tokens.idToken();

    // Cryptographically verify the ID token against Google's JWKs (RS256).
    // verifyIdToken also checks iss, aud, exp, and iat before returning claims.
    const verified = await verifyIdToken(idToken, cfg.GOOGLE_OAUTH_CLIENT_ID, this._verifyOpts);

    // narrowClaims expects Record<string, unknown>; spread to satisfy the index signature.
    return narrowClaims({ ...verified } as Record<string, unknown>);
  }
}

// ---------------------------------------------------------------------------
// Claim narrowing helper (also used in tests)
// ---------------------------------------------------------------------------

/**
 * Narrows a raw decoded JWT payload to `IdTokenClaims`.
 * Throws if required claims are absent or wrong type.
 */
export function narrowClaims(raw: Record<string, unknown>): IdTokenClaims {
  if (typeof raw['sub'] !== 'string') throw new Error('ID token missing sub claim');
  if (typeof raw['email'] !== 'string') throw new Error('ID token missing email claim');
  if (typeof raw['email_verified'] !== 'boolean')
    throw new Error('ID token missing email_verified claim');

  return {
    sub: raw['sub'],
    email: raw['email'],
    email_verified: raw['email_verified'],
    hd: typeof raw['hd'] === 'string' ? raw['hd'] : undefined,
    name: typeof raw['name'] === 'string' ? raw['name'] : undefined,
  };
}

// ---------------------------------------------------------------------------
// Module-level singleton factory (injectable for tests via c.var)
// ---------------------------------------------------------------------------

let _realClient: RealGoogleOAuthClient | undefined;

export function getRealGoogleOAuthClient(): RealGoogleOAuthClient {
  if (_realClient === undefined) {
    _realClient = new RealGoogleOAuthClient();
  }
  return _realClient;
}
