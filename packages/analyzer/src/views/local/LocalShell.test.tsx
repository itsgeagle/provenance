/**
 * LocalShell tests.
 *
 * Verify:
 * 1. Renders the local mode banner without authentication.
 * 2. Renders child route content (v2 chrome via BundleProvider).
 * 3. RequireLocalBundle redirects to /local/load when no bundle is loaded.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LocalShell, RequireLocalBundle } from './LocalShell.js';

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderWithRouter(initialPath: string, routes: React.ReactNode) {
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>{routes}</Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('LocalShell', () => {
  it('renders the local mode banner without authentication', () => {
    // Does NOT use RequireAuth — renders directly.
    renderWithRouter(
      '/local/load',
      <Route path="/local" element={<LocalShell />}>
        <Route path="load" element={<div data-testid="child-content">Load page</div>} />
      </Route>,
    );

    // Banner must be visible.
    expect(screen.getByTestId('local-mode-banner')).toBeInTheDocument();
    expect(screen.getByText(/local mode/i)).toBeInTheDocument();
    expect(screen.getByText(/no data leaves your browser/i)).toBeInTheDocument();
  });

  it('renders child content inside the BundleProvider chrome', () => {
    renderWithRouter(
      '/local/load',
      <Route path="/local" element={<LocalShell />}>
        <Route path="load" element={<div data-testid="child-content">Load page</div>} />
      </Route>,
    );

    expect(screen.getByTestId('child-content')).toBeInTheDocument();
  });

  it('RequireLocalBundle redirects to /local/load when no bundle is loaded', () => {
    // /local/overview uses RequireLocalBundle; with no bundle, should redirect to /local/load.
    renderWithRouter(
      '/local/overview',
      <Route path="/local" element={<LocalShell />}>
        <Route
          path="overview"
          element={
            <RequireLocalBundle>
              <div data-testid="overview">Overview</div>
            </RequireLocalBundle>
          }
        />
        <Route path="load" element={<div data-testid="drop-zone">Load</div>} />
      </Route>,
    );

    // Should redirect to /local/load and show the load zone.
    expect(screen.getByTestId('drop-zone')).toBeInTheDocument();
    expect(screen.queryByTestId('overview')).not.toBeInTheDocument();
  });
});
