/**
 * V45 — RequireSuperadmin
 *
 * Wraps /admin/* routes so only superadmins can render them. RequireAuth
 * upstream has already verified the principal; this layer additionally
 * checks `user.is_superadmin`. Non-superadmins are redirected to /home with
 * no flash of admin chrome.
 */

import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useMe } from '../api/queries.js';

export function RequireSuperadmin({ children }: { children: ReactNode }) {
  const { data, isLoading } = useMe();

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <span className="text-sm text-gray-400">Loading…</span>
      </div>
    );
  }

  if (data === undefined || !data.user.is_superadmin) {
    return <Navigate to="/home" replace />;
  }

  return <>{children}</>;
}
