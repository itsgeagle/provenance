/**
 * V45 — ViewAsBanner smoke tests.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { mswServer } from '../../test-setup.js';
import { ViewAsBanner } from './ViewAsBanner.js';

function render_() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ViewAsBanner />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ViewAsBanner', () => {
  it('renders nothing when view_as is null', async () => {
    mswServer.use(
      http.get('/api/v1/me', () =>
        HttpResponse.json({
          principal_kind: 'session',
          user: {
            id: '00000000-0000-0000-0000-000000000001',
            email: 'sa@berkeley.edu',
            display_name: 'Superadmin',
            is_superadmin: true,
            created_at: '2025-01-01T00:00:00.000Z',
            last_login_at: null,
          },
          memberships: [],
          view_as: null,
        }),
      ),
    );
    render_();
    // Wait a tick to let the query settle, then assert nothing rendered.
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId('view-as-banner')).toBeNull();
  });

  it('renders banner with target email when view_as is set', async () => {
    mswServer.use(
      http.get('/api/v1/me', () =>
        HttpResponse.json({
          principal_kind: 'session',
          user: {
            id: '00000000-0000-0000-0000-000000000001',
            email: 'sa@berkeley.edu',
            display_name: 'Superadmin',
            is_superadmin: true,
            created_at: '2025-01-01T00:00:00.000Z',
            last_login_at: null,
          },
          memberships: [],
          view_as: {
            user: {
              id: '22222222-2222-2222-2222-222222222222',
              email: 'target@berkeley.edu',
              display_name: 'Target',
            },
            started_at: '2025-02-01T00:00:00.000Z',
          },
        }),
      ),
    );
    render_();
    await waitFor(() => expect(screen.getByTestId('view-as-banner')).toBeInTheDocument(), {
      timeout: 3000,
    });
    expect(screen.getByText(/target@berkeley.edu/)).toBeInTheDocument();
    expect(screen.getByTestId('view-as-exit')).toBeInTheDocument();
  });

  it('exit button POSTs to /admin/view-as/exit', async () => {
    let exited = false;
    mswServer.use(
      http.get('/api/v1/me', () =>
        HttpResponse.json({
          principal_kind: 'session',
          user: {
            id: '00000000-0000-0000-0000-000000000001',
            email: 'sa@berkeley.edu',
            display_name: 'Superadmin',
            is_superadmin: true,
            created_at: '2025-01-01T00:00:00.000Z',
            last_login_at: null,
          },
          memberships: [],
          view_as: {
            user: {
              id: '22222222-2222-2222-2222-222222222222',
              email: 'target@berkeley.edu',
              display_name: 'Target',
            },
            started_at: '2025-02-01T00:00:00.000Z',
          },
        }),
      ),
      http.post('/api/v1/admin/view-as/exit', () => {
        exited = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    render_();
    await waitFor(() => expect(screen.getByTestId('view-as-banner')).toBeInTheDocument(), {
      timeout: 3000,
    });
    fireEvent.click(screen.getByTestId('view-as-exit'));
    await waitFor(() => expect(exited).toBe(true), { timeout: 3000 });
  });
});
