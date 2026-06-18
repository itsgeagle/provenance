/**
 * V45 — AdminUsersView smoke tests.
 *
 * Coverage:
 *   - Lists users returned by /admin/users.
 *   - "View as" button calls POST /admin/view-as.
 *   - "Delete" requires two-step confirm before issuing DELETE.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { mswServer } from '../../test-setup.js';
import { AdminUsersView } from './AdminUsersView.js';

const SUPERADMIN_ME = {
  principal_kind: 'session' as const,
  user: {
    id: '00000000-0000-0000-0000-000000000001',
    email: 'sa@berkeley.edu',
    display_name: 'Superadmin',
    is_superadmin: true,
    protected: false,
    created_at: '2025-01-01T00:00:00.000Z',
    last_login_at: '2025-01-15T10:00:00.000Z',
  },
  memberships: [],
  view_as: null,
};

const USER_A = {
  id: '11111111-1111-1111-1111-111111111111',
  email: 'alpha@berkeley.edu',
  display_name: 'Alpha',
  is_superadmin: false,
  protected: false,
  created_at: '2025-02-01T00:00:00.000Z',
  last_login_at: null,
};

function render_() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/admin/users']}>
        <AdminUsersView />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('AdminUsersView', () => {
  it('renders the users list', async () => {
    mswServer.use(
      http.get('/api/v1/me', () => HttpResponse.json(SUPERADMIN_ME)),
      http.get('/api/v1/admin/users', () =>
        HttpResponse.json({ items: [USER_A], next_cursor: null }),
      ),
    );
    render_();
    await waitFor(() => expect(screen.getByTestId('users-table')).toBeInTheDocument(), {
      timeout: 3000,
    });
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('alpha@berkeley.edu')).toBeInTheDocument();
  });

  it('view-as button POSTs to /admin/view-as', async () => {
    let posted = false;
    mswServer.use(
      http.get('/api/v1/me', () => HttpResponse.json(SUPERADMIN_ME)),
      http.get('/api/v1/admin/users', () =>
        HttpResponse.json({ items: [USER_A], next_cursor: null }),
      ),
      http.post('/api/v1/admin/view-as', async ({ request }) => {
        const body = (await request.json()) as { user_id: string };
        if (body.user_id === USER_A.id) posted = true;
        return HttpResponse.json({ ok: true });
      }),
    );

    render_();
    await waitFor(() => expect(screen.getByTestId('users-table')).toBeInTheDocument(), {
      timeout: 3000,
    });

    fireEvent.click(screen.getByTestId(`view-as-btn-${USER_A.id}`));
    await waitFor(() => expect(posted).toBe(true), { timeout: 3000 });
  });

  it('delete requires two-step confirm', async () => {
    let deleted = false;
    mswServer.use(
      http.get('/api/v1/me', () => HttpResponse.json(SUPERADMIN_ME)),
      http.get('/api/v1/admin/users', () =>
        HttpResponse.json({ items: [USER_A], next_cursor: null }),
      ),
      http.delete(`/api/v1/admin/users/${USER_A.id}`, () => {
        deleted = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    render_();
    await waitFor(() => expect(screen.getByTestId('users-table')).toBeInTheDocument(), {
      timeout: 3000,
    });

    fireEvent.click(screen.getByTestId(`delete-btn-${USER_A.id}`));
    expect(deleted).toBe(false);
    fireEvent.click(screen.getByTestId(`delete-confirm-${USER_A.id}`));
    await waitFor(() => expect(deleted).toBe(true), { timeout: 3000 });
  });
});
