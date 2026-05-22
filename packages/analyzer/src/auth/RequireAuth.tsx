/**
 * RequireAuth — route guard for authenticated routes.
 *
 * Reads GET /me via useMe(). Behavior:
 * - Loading: renders a centered loading placeholder.
 * - 401 (UnauthorizedError): redirects to /login?next=<current path>.
 * - Authenticated: renders children.
 *
 * Design note: we do NOT redirect to /login on other errors (e.g. 5xx,
 * network errors) — those should surface as error UI, not loop back to login.
 */

import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useMe } from '../api/queries.js';
import { UnauthorizedError } from '../api/client.js';

interface RequireAuthProps {
  children: ReactNode;
}

export function RequireAuth({ children }: RequireAuthProps) {
  const { data, isLoading, error } = useMe();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <span className="text-sm text-gray-500">Loading…</span>
      </div>
    );
  }

  if (error instanceof UnauthorizedError) {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?next=${next}`} replace />;
  }

  if (error !== null) {
    // Non-401 error: show error UI, don't redirect to login.
    return (
      <div className="flex min-h-screen items-center justify-center">
        <span className="text-sm text-red-600">Failed to load. Please refresh.</span>
      </div>
    );
  }

  if (!data) {
    // data is undefined but no error yet — stay in loading state.
    // This branch shouldn't normally be hit because isLoading covers it,
    // but it prevents an empty render.
    return null;
  }

  return <>{children}</>;
}
