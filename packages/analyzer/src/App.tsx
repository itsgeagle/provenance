/**
 * App — top-level routes.
 *
 * Route structure:
 *   /          → redirect to /load
 *   /load      → LoadView (drop zone; not guarded)
 *   /overview  → OverviewPlaceholder (guarded by RequireBundle)
 *   /timeline  → TimelinePlaceholder (guarded by RequireBundle)
 *
 * <BundleProvider> wraps <Routes> so all routes can read the context.
 * <BundleProvider> itself sits inside <BrowserRouter> (set up in main.tsx).
 *
 * <RequireBundle> redirects to /load when no bundle is loaded (status='idle'
 * and bundles.length === 0). It does NOT redirect during loading or error —
 * LoadView handles those states internally.
 *
 * LoadView redirects to /overview via useEffect when status transitions to
 * 'loaded'.
 */

import type { ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { BundleProvider, useBundle } from './context/BundleContext.js';
import { LoadView } from './views/load/LoadView.js';
import { OverviewPlaceholder } from './views/overview/OverviewPlaceholder.js';
import { TimelinePlaceholder } from './views/timeline/TimelinePlaceholder.js';
import { Layout } from './components/Layout.js';

// ---------------------------------------------------------------------------
// Route guard
// ---------------------------------------------------------------------------

function RequireBundle({ children }: { children: ReactNode }) {
  const { bundles, status } = useBundle();
  if (status === 'idle' && bundles.length === 0) {
    return <Navigate to="/load" replace />;
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
                <OverviewPlaceholder />
              </Layout>
            </RequireBundle>
          }
        />
        <Route
          path="/timeline"
          element={
            <RequireBundle>
              <Layout>
                <TimelinePlaceholder />
              </Layout>
            </RequireBundle>
          }
        />
        <Route path="/" element={<Navigate to="/load" replace />} />
      </Routes>
    </BundleProvider>
  );
}
