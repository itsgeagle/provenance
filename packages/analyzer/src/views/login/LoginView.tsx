/**
 * LoginView — single "Sign in with Google" button.
 *
 * Auth flow (per V16 + auth.ts review):
 * - Submits a form POST to /api/v1/auth/google/start
 * - Server returns 302 → Google authorize URL; browser follows automatically
 * - Google redirects back to /api/v1/auth/google/callback
 * - Callback sets session cookie + redirects to return_to (/ by default)
 *
 * Error rendering:
 * - If `?error=<code>` is in the URL (set by the OAuth callback on failure),
 *   an error message is rendered above the sign-in button.
 *
 * The `next` param from RequireAuth (?next=/home) is forwarded to
 * /auth/google/start as `return_to` so the user lands back where they came from.
 */

import { useSearchParams } from 'react-router-dom';
import { GoogleSignInButton } from '../../components/GoogleSignInButton.js';

const ERROR_MESSAGES: Record<string, string> = {
  HOSTED_DOMAIN_MISMATCH:
    'Your account is not on an allowed domain. Use your @berkeley.edu account.',
  EMAIL_NOT_VERIFIED:
    'Your Google account email is not verified. Please verify your email and try again.',
  OAUTH_STATE_MISMATCH: 'Sign-in session expired or was tampered with. Please try again.',
  OAUTH_CODE_EXCHANGE_FAILED: 'Could not complete sign-in with Google. Please try again.',
};

function getErrorMessage(code: string): string {
  return ERROR_MESSAGES[code] ?? `Sign-in failed (${code}). Please try again.`;
}

export function LoginView() {
  const [searchParams] = useSearchParams();
  const errorCode = searchParams.get('error');
  const next = searchParams.get('next');

  // Build the return_to param: if we have a next path, use it; otherwise /home.
  const returnTo = next ?? '/home';

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gray-50">
      <div className="w-full max-w-sm rounded-xl border border-gray-200 bg-white p-8 shadow-sm">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-gray-900">Provenance</h1>
          <p className="mt-1 text-sm text-gray-500">Academic integrity telemetry</p>
        </div>

        {errorCode !== null && (
          <div
            role="alert"
            className="mb-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
          >
            {getErrorMessage(errorCode)}
          </div>
        )}

        <GoogleSignInButton returnTo={returnTo} />
      </div>
    </div>
  );
}
