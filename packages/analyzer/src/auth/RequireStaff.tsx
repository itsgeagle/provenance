/**
 * RequireStaff — authorization guard for staff-only routes (e.g. /local).
 *
 * Layered BELOW RequireAuth (which has already verified a session). This adds
 * an authorization check: the principal must be course staff — i.e. have at
 * least one semester membership, or be a superadmin.
 *
 * Why this exists: RequireAuth only proves a valid @berkeley.edu session, which
 * every student has. Membership is the invite-only boundary that distinguishes
 * staff from students. Non-staff are redirected to /home (where they see the
 * "Ask an admin to invite you" empty state), with no flash of staff chrome.
 */

import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useMe } from '../api/queries.js';

export function RequireStaff({ children }: { children: ReactNode }) {
  const { data, isLoading } = useMe();

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <span className="text-sm text-gray-500">Loading…</span>
      </div>
    );
  }

  if (data === undefined || (data.memberships.length === 0 && !data.user.is_superadmin)) {
    return <Navigate to="/home" replace />;
  }

  return <>{children}</>;
}
