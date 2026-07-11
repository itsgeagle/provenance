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
import { RouteLoading } from '../components/a11y/RouteLoading.js';

export function RequireStaff({ children }: { children: ReactNode }) {
  const { data, isLoading } = useMe();

  if (isLoading) {
    return <RouteLoading />;
  }

  if (data === undefined || (data.memberships.length === 0 && !data.user.is_superadmin)) {
    return <Navigate to="/home" replace />;
  }

  return <>{children}</>;
}
