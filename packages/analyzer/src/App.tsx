/**
 * App — top-level routes.
 *
 * Route structure:
 *   /          → redirect to /load
 *   /load      → LoadView (drop zone; not guarded)
 *   /overview  → OverviewView (guarded by RequireBundle: bundles.length >= 1)
 *   /timeline  → TimelineView (guarded by RequireBundle: bundles.length >= 1)
 *   /compare        → CompareView (guarded by RequireMultiBundles: bundles.length >= 2)
 *   /replay/:id     → ReplayView (guarded by RequireBundle; inner guard checks session exists)
 *
 * <BundleProvider> wraps <Routes> so all routes can read the context.
 * <BundleProvider> itself sits inside <BrowserRouter> (set up in main.tsx).
 *
 * <RequireBundle> redirects to /load whenever status is not 'loaded'.
 * This ensures guarded routes are only accessible when a bundle is fully loaded.
 *
 * <RequireMultiBundles> redirects to /load when fewer than 2 bundles are loaded.
 * Used for the /compare route (Phase 11).
 *
 * LoadView redirects to /overview via useEffect when status transitions to
 * 'loaded'.
 */

import type { ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { BundleProvider, useBundle } from './context/BundleContext.js';
import { LoadView } from './views/load/LoadView.js';
import { OverviewView } from './views/overview/OverviewView.js';
import { TimelineView } from './views/timeline/TimelineView.js';
import { CompareView } from './views/compare/CompareView.js';
import { ReplayView } from './views/replay/ReplayView.js';
import { Layout } from './components/Layout.js';

// ---------------------------------------------------------------------------
// Route guards
// ---------------------------------------------------------------------------

function RequireBundle({ children }: { children: ReactNode }) {
  const { status } = useBundle();
  if (status !== 'loaded') {
    return <Navigate to="/load" replace />;
  }
  return <>{children}</>;
}

/**
 * Guard for routes that require at least 2 bundles (e.g. /compare).
 *
 * Design choice (A26): redirect to /load rather than showing a placeholder page.
 * Rationale: /load is where the user loads files; redirecting there with the
 * existing bundles list still in memory is confusing if bundles.length === 1.
 * Instead we redirect there only when nothing is loaded (status !== 'loaded');
 * when exactly 1 bundle is loaded we redirect to /overview so the user sees
 * something useful and can use the "Load more bundles" button in the header.
 */
function RequireMultiBundles({ children }: { children: ReactNode }) {
  const { status, bundles } = useBundle();
  if (status !== 'loaded') {
    return <Navigate to="/load" replace />;
  }
  if (bundles.length < 2) {
    // One bundle loaded — redirect to overview. The "Load more bundles" header
    // button gives the user a path to add a second bundle without going back to
    // the drop zone.
    return <Navigate to="/overview" replace />;
  }
  return <>{children}</>;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export function App() {
  return (
    <BundleProvider>
      <Routes>
        <Route path="/load" element={<LoadView />} />
        <Route
          path="/overview"
          element={
            <RequireBundle>
              <Layout>
                <OverviewView />
              </Layout>
            </RequireBundle>
          }
        />
        <Route
          path="/timeline"
          element={
            <RequireBundle>
              <Layout>
                <TimelineView />
              </Layout>
            </RequireBundle>
          }
        />
        <Route
          path="/compare"
          element={
            <RequireMultiBundles>
              <Layout>
                <CompareView />
              </Layout>
            </RequireMultiBundles>
          }
        />
        <Route
          path="/replay/:sessionId"
          element={
            <RequireBundle>
              <ReplayView />
            </RequireBundle>
          }
        />
        <Route path="/" element={<Navigate to="/load" replace />} />
        <Route path="*" element={<Navigate to="/load" replace />} />
      </Routes>
    </BundleProvider>
  );
}
