/**
 * MembersView tests.
 *
 * - Happy path: renders members table and pending invitations.
 * - Invite form: validates email format client-side.
 * - Invite mutation: submits to API on valid email.
 * - Remove error: LAST_ADMIN_REQUIRED shows in toast.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { mswServer } from '../../test-setup.js';
import {
  DEFAULT_COURSE_SLUG,
  DEFAULT_SEMESTER_ID,
  DEFAULT_SEMESTER_SLUG,
  membersHandler,
} from '../../test/msw-handlers.js';
import { MembersView } from './MembersView.js';

function renderMembersView() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/s/${DEFAULT_COURSE_SLUG}/${DEFAULT_SEMESTER_SLUG}/members`]}>
        <Routes>
          <Route path="/s/:courseSlug/:semesterSlug/members" element={<MembersView />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// All IDs must be valid UUIDs (hex chars only)
const ALICE_USER_ID = 'a1000000-0000-0000-0000-000000000001';

const defaultMembers = [
  {
    user_id: ALICE_USER_ID,
    email: 'alice@berkeley.edu',
    display_name: 'Alice',
    role: 'admin',
    granted_at: '2025-01-01T00:00:00.000Z',
    granted_by_email: null,
  },
];

describe('MembersView', () => {
  it('renders members table', async () => {
    mswServer.use(membersHandler(defaultMembers));

    renderMembersView();

    await waitFor(() => expect(screen.getByTestId('members-table')).toBeInTheDocument(), {
      timeout: 3000,
    });
    expect(screen.getByText('alice@berkeley.edu')).toBeInTheDocument();
    expect(screen.getByText('Alice')).toBeInTheDocument();
  });

  it('shows pending invitations table when there are pending invites', async () => {
    mswServer.use(
      membersHandler(defaultMembers, [
        {
          id: 'b1000000-0000-0000-0000-000000000001',
          email: 'bob@berkeley.edu',
          role: 'grader',
          invited_at: '2025-01-05T00:00:00.000Z',
          invited_by_email: 'alice@berkeley.edu',
        },
      ]),
    );

    renderMembersView();

    await waitFor(() => expect(screen.getByTestId('pending-table')).toBeInTheDocument(), {
      timeout: 3000,
    });
    expect(screen.getByText('bob@berkeley.edu')).toBeInTheDocument();
  });

  it('shows email validation error for invalid email', async () => {
    mswServer.use(membersHandler([]));
    renderMembersView();

    await waitFor(() => expect(screen.getByTestId('invite-email-input')).toBeInTheDocument(), {
      timeout: 3000,
    });

    fireEvent.change(screen.getByTestId('invite-email-input'), {
      target: { value: 'not-an-email' },
    });
    fireEvent.click(screen.getByTestId('invite-submit'));

    expect(screen.getByTestId('email-error')).toBeInTheDocument();
  });

  it('submits invite with valid email', async () => {
    mswServer.use(membersHandler(defaultMembers));

    let inviteCalled = false;
    mswServer.use(
      http.post(`/api/v1/semesters/${DEFAULT_SEMESTER_ID}/members`, async ({ request }) => {
        const body = (await request.json()) as { email: string; role: string };
        inviteCalled = true;
        expect(body.email).toBe('new@berkeley.edu');
        return HttpResponse.json(
          {
            pending: {
              id: 'c1000000-0000-0000-0000-000000000001',
              email: 'new@berkeley.edu',
              role: 'grader',
              invited_at: '2025-01-10T00:00:00.000Z',
              invited_by_email: 'alice@berkeley.edu',
            },
          },
          { status: 201 },
        );
      }),
    );

    renderMembersView();

    await waitFor(() => expect(screen.getByTestId('invite-email-input')).toBeInTheDocument(), {
      timeout: 3000,
    });
    fireEvent.change(screen.getByTestId('invite-email-input'), {
      target: { value: 'new@berkeley.edu' },
    });
    fireEvent.click(screen.getByTestId('invite-submit'));

    await waitFor(() => expect(inviteCalled).toBe(true), { timeout: 3000 });
  });

  it('shows toast with LAST_ADMIN_REQUIRED error when remove fails', async () => {
    mswServer.use(membersHandler(defaultMembers));

    mswServer.use(
      http.delete(`/api/v1/semesters/${DEFAULT_SEMESTER_ID}/members/${ALICE_USER_ID}`, () =>
        HttpResponse.json(
          { error: { code: 'LAST_ADMIN_REQUIRED', message: 'Cannot remove the last admin.' } },
          { status: 409 },
        ),
      ),
    );

    renderMembersView();

    await waitFor(() => expect(screen.getByTestId('members-table')).toBeInTheDocument(), {
      timeout: 3000,
    });

    // Click remove → confirm
    fireEvent.click(screen.getByTestId(`remove-btn-${ALICE_USER_ID}`));
    await waitFor(
      () => expect(screen.getByTestId(`remove-confirm-${ALICE_USER_ID}`)).toBeInTheDocument(),
      { timeout: 3000 },
    );
    fireEvent.click(screen.getByTestId(`remove-confirm-${ALICE_USER_ID}`));

    await waitFor(() => expect(screen.getByTestId('toast')).toBeInTheDocument(), { timeout: 3000 });
    expect(screen.getByTestId('toast')).toHaveTextContent('Cannot remove the last admin.');
  });
});
