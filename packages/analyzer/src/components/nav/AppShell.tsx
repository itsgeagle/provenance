/**
 * AppShell — top navigation bar + content area.
 *
 * Structure:
 * - Top bar: Provenance logo, SemesterSwitcher (if multiple semesters), user menu
 * - User menu: displays email, links to /me/tokens, logout button
 * - Children rendered below the top bar in a flex-grow content area
 */

import type { ReactNode } from 'react';
import { Link, NavLink, useNavigate, useParams } from 'react-router-dom';
import { useMe, useLogout, useSemesters } from '../../api/queries.js';
import { SemesterSwitcher } from './SemesterSwitcher.js';

interface AppShellProps {
  children: ReactNode;
}

// ---------------------------------------------------------------------------
// Admin nav links — visible only to admins on /s/:semesterSlug/* routes
// ---------------------------------------------------------------------------

function SemesterAdminNav() {
  const { semesterSlug } = useParams<{ semesterSlug?: string }>();
  const { data: semesters } = useSemesters();

  if (!semesterSlug) return null;

  const membership = semesters?.find((s) => s.semester_slug === semesterSlug);
  if (membership?.role !== 'admin') return null;

  const base = `/s/${semesterSlug}`;
  const navClass = ({ isActive }: { isActive: boolean }) =>
    `text-xs px-2 py-1 rounded transition-colors ${
      isActive
        ? 'bg-indigo-100 text-indigo-700 font-medium'
        : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'
    }`;

  const adminLinks: Array<{ to: string; label: string; end?: boolean }> = [
    { to: base, label: 'Cohort', end: true },
    { to: `${base}/ingest`, label: 'Ingest' },
    { to: `${base}/unmatched`, label: 'Unmatched' },
    { to: `${base}/roster`, label: 'Roster' },
    { to: `${base}/members`, label: 'Members' },
    { to: `${base}/assignments`, label: 'Assignments' },
    { to: `${base}/settings`, label: 'Settings' },
  ];

  return (
    <nav
      className="flex items-center gap-1 ml-4"
      aria-label="Semester admin"
      data-testid="admin-nav"
    >
      {adminLinks.map(({ to, label, end }) => (
        <NavLink key={to} to={to} end={end ?? false} className={navClass}>
          {label}
        </NavLink>
      ))}
    </nav>
  );
}

// ---------------------------------------------------------------------------
// AppShell
// ---------------------------------------------------------------------------

export function AppShell({ children }: AppShellProps) {
  const { data: me } = useMe();
  const { mutate: logout, isPending: isLoggingOut } = useLogout();
  const navigate = useNavigate();

  function handleLogout() {
    logout(undefined, {
      onSuccess: () => {
        void navigate('/login');
      },
    });
  }

  return (
    <div className="flex min-h-screen flex-col">
      {/* Top bar */}
      <header className="flex h-14 items-center border-b border-gray-200 bg-white px-4 overflow-x-auto">
        {/* Logo */}
        <Link to="/home" className="mr-4 shrink-0 text-sm font-semibold text-gray-900">
          Provenance
        </Link>

        {/* Semester switcher (renders nothing if <= 1 semester) */}
        <SemesterSwitcher />

        {/* Admin nav links (only on /s/:semesterSlug routes for admins) */}
        <SemesterAdminNav />

        {/* Spacer */}
        <div className="flex-1" />

        {/* User menu */}
        {me !== undefined && (
          <div className="flex shrink-0 items-center gap-3">
            <span className="text-xs text-gray-500">{me.user.email}</span>
            <button
              onClick={handleLogout}
              disabled={isLoggingOut}
              className="rounded-md border border-gray-300 bg-white px-3 py-1 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              data-testid="logout-button"
            >
              {isLoggingOut ? 'Signing out…' : 'Sign out'}
            </button>
          </div>
        )}
      </header>

      {/* Page content */}
      <main className="flex flex-1 flex-col">{children}</main>
    </div>
  );
}
