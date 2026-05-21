/**
 * FakeGoogleOAuthClient — shared test helper.
 *
 * Used by auth.test.ts and google.test.ts to inject a pre-baked
 * GoogleOAuthClient without network access.
 */

import type { GoogleOAuthClient, IdTokenClaims } from '../../src/auth/google.js';

export class FakeGoogleOAuthClient implements GoogleOAuthClient {
  private readonly fixedState: string;
  private readonly fixedCodeVerifier: string;
  private claimsToReturn: IdTokenClaims;
  private shouldThrow: boolean;
  private throwMessage: string;

  constructor(opts?: {
    state?: string;
    codeVerifier?: string;
    claims?: IdTokenClaims;
    shouldThrow?: boolean;
    throwMessage?: string;
  }) {
    this.fixedState = opts?.state ?? 'fixed-state-for-tests';
    this.fixedCodeVerifier = opts?.codeVerifier ?? 'fixed-code-verifier-for-tests';
    this.claimsToReturn = opts?.claims ?? {
      sub: 'google-sub-123',
      email: 'student@berkeley.edu',
      email_verified: true,
      hd: 'berkeley.edu',
      name: 'Test Student',
    };
    this.shouldThrow = opts?.shouldThrow ?? false;
    this.throwMessage = opts?.throwMessage ?? 'Token exchange failed';
  }

  /** Reconfigure claims mid-test. */
  setClaims(claims: IdTokenClaims): void {
    this.claimsToReturn = claims;
  }

  /** Make the next exchangeCodeAndVerify throw. */
  setThrow(message?: string): void {
    this.shouldThrow = true;
    if (message !== undefined) this.throwMessage = message;
  }

  generatePkceParams(): { state: string; codeVerifier: string } {
    return { state: this.fixedState, codeVerifier: this.fixedCodeVerifier };
  }

  createAuthorizeUrl(args: {
    state: string;
    codeVerifier: string;
    redirectUri: string;
  }): string {
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', 'fake-client-id');
    url.searchParams.set('redirect_uri', args.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('state', args.state);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('code_challenge', 'fake-challenge');
    url.searchParams.set('hd', 'berkeley.edu');
    return url.toString();
  }

  async exchangeCodeAndVerify(_args: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<IdTokenClaims> {
    if (this.shouldThrow) {
      throw new Error(this.throwMessage);
    }
    return this.claimsToReturn;
  }
}
