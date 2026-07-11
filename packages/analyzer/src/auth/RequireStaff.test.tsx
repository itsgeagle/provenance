/**
 * RequireStaff tests.
 *
 * - Member (default /me) → children rendered.
 * - Superadmin with no memberships → children rendered.
 * - Authenticated non-staff (no memberships, not superadmin) → redirect to /home.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http } from 'msw';
import { mswServer } from '../test-setup.js';
import { meNoSemestersHandler, defaultMeResponse, defaultUser } from '../test/msw-handlers.js';
import { RequireStaff } from './RequireStaff.js';

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderGuarded() {
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <MemoryRouter initialEntries={['/local/load']}>
        <Routes>
          <Route path="/home" element={<div data-testid="home-page">Home</div>} />
          <Route
            path="/local/load"
            element={
              <RequireStaff>
                <div data-testid="staff-content">Staff Content</div>
              </RequireStaff>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('RequireStaff', () => {
  it('renders children for a user with a membership', async () => {
    // Default handler returns a user with one membership.
    renderGuarded();
    await waitFor(() => {
      expect(screen.getByTestId('staff-content')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('home-page')).not.toBeInTheDocument();
  });

  it('renders children for a superadmin with no memberships', async () => {
    mswServer.use(
      http.get('/api/v1/me', () =>
        Response.json({
          ...defaultMeResponse,
          user: { ...defaultUser, is_superadmin: true },
          memberships: [],
        }),
      ),
    );
    renderGuarded();
    await waitFor(() => {
      expect(screen.getByTestId('staff-content')).toBeInTheDocument();
    });
  });

  it('redirects a non-staff user (no memberships, not superadmin) to /home', async () => {
    mswServer.use(meNoSemestersHandler());
    renderGuarded();
    await waitFor(() => {
      expect(screen.getByTestId('home-page')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('staff-content')).not.toBeInTheDocument();
  });
});
