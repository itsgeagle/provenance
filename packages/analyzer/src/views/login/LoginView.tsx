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

        {/* POST form — browser follows the 302 redirect automatically */}
        <form
          method="POST"
          action={`/api/v1/auth/google/start?return_to=${encodeURIComponent(returnTo)}`}
        >
          <button
            type="submit"
            className="flex w-full items-center justify-center gap-3 rounded-md border border-gray-300 bg-white px-4 py-2.5 text-sm font-medium text-gray-700 shadow-sm transition hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
          >
            <GoogleIcon />
            Sign in with Google
          </button>
        </form>
      </div>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path
        d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"
        fill="#4285F4"
      />
      <path
        d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"
        fill="#34A853"
      />
      <path
        d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"
        fill="#FBBC05"
      />
      <path
        d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 6.29C4.672 4.163 6.656 3.58 9 3.58z"
        fill="#EA4335"
      />
    </svg>
  );
}
