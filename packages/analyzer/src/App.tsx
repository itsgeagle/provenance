/**
 * App — top-level routes.
 *
 * Route structure (v3 + legacy v2 routes preserved):
 *
 *   /                  → redirect to /home
 *   /login             → LoginView (no auth required)
 *   /home              → RequireAuth + AppShell + HomeView
 *   /s/:semesterSlug/* → (Phase 21+) cohort + drill-in views (placeholder until Phase 21)
 *
 * Legacy v2 SPA routes (preserved; move to /local in Phase 25):
 *   /load      → LoadView (drop zone; not guarded)
 *   /overview  → OverviewView (guarded by RequireBundle)
 *   /timeline  → TimelineView (guarded by RequireBundle)
 *   /compare   → CompareView (guarded by RequireMultiBundles)
 *   /replay/:sessionId → ReplayView (guarded by RequireBundle)
 *
 * Legacy routes are grouped under a layout route whose element is
 * <BundleProviderLayout> so that <BundleProvider> wraps exactly those routes.
 * <QueryClientProvider> is set up in main.tsx and wraps the entire app.
 */

import type { ReactNode } from 'react';
import { Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { BundleProvider, useBundle } from './context/BundleContext.js';
import { LoadView } from './views/load/LoadView.js';
import { OverviewView } from './views/overview/OverviewView.js';
import { TimelineView } from './views/timeline/TimelineView.js';
import { CompareView } from './views/compare/CompareView.js';
import { ReplayView } from './views/replay/ReplayView.js';
import { Layout } from './components/Layout.js';
import { LoginView } from './views/login/LoginView.js';
import { HomeView } from './views/home/HomeView.js';
import { AppShell } from './components/nav/AppShell.js';
import { RequireAuth } from './auth/RequireAuth.js';
import { CohortView } from './views/cohort/CohortView.js';
import { IngestStartView } from './views/ingest/IngestStartView.js';
import { IngestJobView } from './views/ingest/IngestJobView.js';
import { UnmatchedView } from './views/unmatched/UnmatchedView.js';
import { RosterView } from './views/roster/RosterView.js';
import { MembersView } from './views/members/MembersView.js';
import { AssignmentsView } from './views/assignments/AssignmentsView.js';
import { SemesterSettingsView } from './views/settings/SemesterSettingsView.js';
import { SubmissionShell } from './views/submission/SubmissionShell.js';
import { TuningView } from './views/heuristics/TuningView.js';
import { CrossFlagListView } from './views/cross-flags/CrossFlagListView.js';
import { CrossFlagDetailView } from './views/cross-flags/CrossFlagDetailView.js';

// ---------------------------------------------------------------------------
// Legacy v2 route guards
// ---------------------------------------------------------------------------

/** Layout route element that provides BundleContext to legacy routes. */
function BundleProviderLayout() {
  return (
    <BundleProvider>
      <Outlet />
    </BundleProvider>
  );
}

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
    <Routes>
      {/* ── v3 routes ───────────────────────────────────────────────────── */}
      <Route path="/login" element={<LoginView />} />

      <Route
        path="/home"
        element={
          <RequireAuth>
            <AppShell>
              <HomeView />
            </AppShell>
          </RequireAuth>
        }
      />

      {/* /s/:semesterSlug — cohort + admin views (Phase 21/22) */}
      {/* Wrap all /s/:semesterSlug routes in RequireAuth + AppShell once */}
      <Route
        path="/s/:semesterSlug"
        element={
          <RequireAuth>
            <AppShell>
              <CohortView />
            </AppShell>
          </RequireAuth>
        }
      />
      <Route
        path="/s/:semesterSlug/ingest"
        element={
          <RequireAuth>
            <AppShell>
              <IngestStartView />
            </AppShell>
          </RequireAuth>
        }
      />
      <Route
        path="/s/:semesterSlug/ingest/jobs/:jobId"
        element={
          <RequireAuth>
            <AppShell>
              <IngestJobView />
            </AppShell>
          </RequireAuth>
        }
      />
      <Route
        path="/s/:semesterSlug/unmatched"
        element={
          <RequireAuth>
            <AppShell>
              <UnmatchedView />
            </AppShell>
          </RequireAuth>
        }
      />
      <Route
        path="/s/:semesterSlug/roster"
        element={
          <RequireAuth>
            <AppShell>
              <RosterView />
            </AppShell>
          </RequireAuth>
        }
      />
      <Route
        path="/s/:semesterSlug/members"
        element={
          <RequireAuth>
            <AppShell>
              <MembersView />
            </AppShell>
          </RequireAuth>
        }
      />
      <Route
        path="/s/:semesterSlug/assignments"
        element={
          <RequireAuth>
            <AppShell>
              <AssignmentsView />
            </AppShell>
          </RequireAuth>
        }
      />
      <Route
        path="/s/:semesterSlug/settings"
        element={
          <RequireAuth>
            <AppShell>
              <SemesterSettingsView />
            </AppShell>
          </RequireAuth>
        }
      />
      {/* Phase 23: per-submission drill-in via SubmissionShell */}
      <Route
        path="/s/:semesterSlug/sub/:submissionId"
        element={
          <RequireAuth>
            <AppShell>
              <SubmissionShell />
            </AppShell>
          </RequireAuth>
        }
      />
      {/* Phase 24: heuristic tuning */}
      <Route
        path="/s/:semesterSlug/tuning"
        element={
          <RequireAuth>
            <AppShell>
              <TuningView />
            </AppShell>
          </RequireAuth>
        }
      />
      {/* Phase 24: cross-flags list */}
      <Route
        path="/s/:semesterSlug/cross-flags"
        element={
          <RequireAuth>
            <AppShell>
              <CrossFlagListView />
            </AppShell>
          </RequireAuth>
        }
      />
      {/* Phase 24: cross-flag detail */}
      <Route
        path="/s/:semesterSlug/cross-flags/:crossFlagId"
        element={
          <RequireAuth>
            <AppShell>
              <CrossFlagDetailView />
            </AppShell>
          </RequireAuth>
        }
      />

      {/* ── legacy v2 SPA routes (preserved until Phase 25) ─────────────── */}
      {/* Grouped under a layout route so BundleProvider wraps them all.     */}
      <Route element={<BundleProviderLayout />}>
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
      </Route>

      {/* ── root redirect ────────────────────────────────────────────────── */}
      {/* / → /home (RequireAuth on /home redirects to /login if unauthed) */}
      <Route path="/" element={<Navigate to="/home" replace />} />
      <Route path="*" element={<Navigate to="/home" replace />} />
    </Routes>
  );
}
