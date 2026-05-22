/**
 * AppShell — top navigation bar + content area.
 *
 * Structure:
 * - Top bar: Provenance logo, SemesterSwitcher (if multiple semesters), user menu
 * - User menu: displays email, links to /me/tokens, logout button
 * - Children rendered below the top bar in a flex-grow content area
 */

import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMe, useLogout } from '../../api/queries.js';
import { SemesterSwitcher } from './SemesterSwitcher.js';

interface AppShellProps {
  children: ReactNode;
}

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
      <header className="flex h-14 items-center border-b border-gray-200 bg-white px-4">
        {/* Logo */}
        <Link to="/home" className="mr-4 text-sm font-semibold text-gray-900">
          Provenance
        </Link>

        {/* Semester switcher (renders nothing if <= 1 semester) */}
        <SemesterSwitcher />

        {/* Spacer */}
        <div className="flex-1" />

        {/* User menu */}
        {me !== undefined && (
          <div className="flex items-center gap-3">
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
