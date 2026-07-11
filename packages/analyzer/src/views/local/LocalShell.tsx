/**
 * LocalShell — layout wrapper for the /local/* subtree.
 *
 * The /local routes are the v2 "drop a zip" standalone experience. The
 * analysis itself runs entirely in-browser — no server API calls — but the
 * subtree is staff-gated (see below), so it is not unauthenticated.
 *
 * /local is now staff-gated — see App.tsx, where the subtree is wrapped in
 * RequireAuth + RequireStaff (PRD §15 amended 2026-07-10).
 *
 * Layout:
 *   <LocalShell>
 *     ┌────────────────────────────────────────────────────────────────────────┐
 *     │  LOCAL MODE BANNER                                                     │
 *     ├────────────────────────────────────────────────────────────────────────┤
 *     │  <BundleProvider> wraps <Outlet /> (load / overview / timeline etc.)  │
 *     └────────────────────────────────────────────────────────────────────────┘
 */

import { BundleProvider, useBundle } from '../../context/BundleContext.js';
import { Navigate, Outlet } from 'react-router-dom';
import type { ReactNode } from 'react';

// ---------------------------------------------------------------------------
// Bundle guards (same semantics as App.tsx, adapted for /local prefix)
// ---------------------------------------------------------------------------

/** Redirects to /local/load if no bundle is loaded. */
export function RequireLocalBundle({ children }: { children: ReactNode }) {
  const { status } = useBundle();
  if (status !== 'loaded') {
    return <Navigate to="/local/load" replace />;
  }
  return <>{children}</>;
}

/**
 * Redirects to /local/load if fewer than two bundles are loaded.
 * If exactly one bundle is loaded, redirects to /local/overview so the user
 * sees something useful.
 */
export function RequireLocalMultiBundles({ children }: { children: ReactNode }) {
  const { status, bundles } = useBundle();
  if (status !== 'loaded') {
    return <Navigate to="/local/load" replace />;
  }
  if (bundles.length < 2) {
    return <Navigate to="/local/overview" replace />;
  }
  return <>{children}</>;
}

// ---------------------------------------------------------------------------
// Banner
// ---------------------------------------------------------------------------

function LocalModeBanner() {
  return (
    <div
      className="bg-blue-50 border-b border-blue-200 px-4 py-2 text-center text-sm text-blue-700"
      role="banner"
      data-testid="local-mode-banner"
    >
      <span className="font-medium">Local mode</span> — no data leaves your browser
    </div>
  );
}

// ---------------------------------------------------------------------------
// LocalShell
// ---------------------------------------------------------------------------

/**
 * Top-level layout component for the /local subtree.
 *
 * Wraps all /local/* routes in <BundleProvider> so the existing v2 route
 * elements (LoadView, OverviewView, etc.) have access to BundleContext.
 * Auth is enforced one level up in App.tsx (RequireAuth + RequireStaff wrap
 * this subtree).
 */
export function LocalShell() {
  return (
    <BundleProvider>
      <div className="h-screen flex flex-col overflow-hidden">
        <LocalModeBanner />
        <div className="flex-1 min-h-0">
          <Outlet />
        </div>
      </div>
    </BundleProvider>
  );
}
