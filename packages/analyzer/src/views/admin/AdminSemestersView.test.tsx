/**
 * AdminSemestersView — "add me as admin" tests.
 *
 * A superadmin who creates a semester gets NO membership (PRD: superadmins are
 * never auto-included in content access). Every per-semester page resolves the
 * semester from the membership list, so there's no in-app way to add yourself —
 * unless the admin sub-app, which already has the real semester id, offers it.
 * These tests pin that affordance: "Add me as admin" shows for semesters you're
 * not in, hides for ones you are, and POSTs role=admin to the right semester.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { mswServer } from '../../test-setup.js';
import { AdminSemestersView } from './AdminSemestersView.js';

const COURSE_ID = 'cc000000-0000-0000-0000-000000000001';

const SUPERADMIN_ME = {
  principal_kind: 'session' as const,
  user: {
    id: '00000000-0000-0000-0000-000000000001',
    email: 'sa@berkeley.edu',
    display_name: 'Superadmin',
    is_superadmin: true,
    created_at: '2025-01-01T00:00:00.000Z',
    last_login_at: '2025-01-15T10:00:00.000Z',
  },
  memberships: [],
  view_as: null,
};

const COURSES = {
  courses: [{ id: COURSE_ID, name: 'CS 61A', slug: 'cs61a', archived: false, semesters_count: 1 }],
};

function makeSemester(
  overrides: Partial<{ id: string; slug: string; my_role: string | null; archived: boolean }> = {},
) {
  return {
    id: overrides.id ?? 'cc000000-0000-0000-0000-0000000000aa',
    course_id: COURSE_ID,
    slug: overrides.slug ?? 'fa26',
    term: 'fa',
    year: 2026,
    display_name: 'Fall 2026',
    archived: overrides.archived ?? false,
    submission_count: 0,
    student_count: 0,
    assignment_count: 0,
    active_config_version: 0,
    my_role: overrides.my_role === undefined ? null : overrides.my_role,
  };
}

function render_() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/admin/courses/${COURSE_ID}/semesters`]}>
        <Routes>
          <Route path="/admin/courses/:courseId/semesters" element={<AdminSemestersView />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('AdminSemestersView — add me as admin', () => {
  it('shows "Add me as admin" for a semester the superadmin is not a member of', async () => {
    mswServer.use(
      http.get('/api/v1/me', () => HttpResponse.json(SUPERADMIN_ME)),
      http.get('/api/v1/courses', () => HttpResponse.json(COURSES)),
      http.get(`/api/v1/courses/${COURSE_ID}/semesters`, () =>
        HttpResponse.json({ semesters: [makeSemester({ slug: 'fa26', my_role: null })] }),
      ),
    );

    render_();

    await waitFor(() => expect(screen.getByTestId('add-me-fa26')).toBeInTheDocument(), {
      timeout: 3000,
    });
    // Settings link should NOT be offered until you're a member (the page can't
    // load without a membership row).
    expect(screen.queryByText('Open settings →')).not.toBeInTheDocument();
  });

  it('shows the settings link (not "Add me") once the superadmin is a member', async () => {
    mswServer.use(
      http.get('/api/v1/me', () => HttpResponse.json(SUPERADMIN_ME)),
      http.get('/api/v1/courses', () => HttpResponse.json(COURSES)),
      http.get(`/api/v1/courses/${COURSE_ID}/semesters`, () =>
        HttpResponse.json({ semesters: [makeSemester({ slug: 'fa26', my_role: 'admin' })] }),
      ),
    );

    render_();

    await waitFor(() => expect(screen.getByText('Open settings →')).toBeInTheDocument(), {
      timeout: 3000,
    });
    expect(screen.queryByTestId('add-me-fa26')).not.toBeInTheDocument();
  });

  it('clicking "Add me as admin" POSTs role=admin with the superadmin email to that semester', async () => {
    const semesterId = 'cc000000-0000-0000-0000-0000000000aa';
    let posted: unknown;
    mswServer.use(
      http.get('/api/v1/me', () => HttpResponse.json(SUPERADMIN_ME)),
      http.get('/api/v1/courses', () => HttpResponse.json(COURSES)),
      http.get(`/api/v1/courses/${COURSE_ID}/semesters`, () =>
        HttpResponse.json({ semesters: [makeSemester({ id: semesterId, slug: 'fa26' })] }),
      ),
      http.post(`/api/v1/semesters/${semesterId}/members`, async ({ request }) => {
        posted = await request.json();
        return HttpResponse.json({ kind: 'member' });
      }),
    );

    render_();

    const btn = await screen.findByTestId('add-me-fa26');
    fireEvent.click(btn);

    await waitFor(() => expect(posted).toEqual({ email: 'sa@berkeley.edu', role: 'admin' }), {
      timeout: 3000,
    });
  });
});

describe('AdminSemestersView — archive', () => {
  const semesterId = 'cc000000-0000-0000-0000-0000000000aa';

  function mockBase(semester: ReturnType<typeof makeSemester>) {
    mswServer.use(
      http.get('/api/v1/me', () => HttpResponse.json(SUPERADMIN_ME)),
      http.get('/api/v1/courses', () => HttpResponse.json(COURSES)),
      http.get(`/api/v1/courses/${COURSE_ID}/semesters`, () =>
        HttpResponse.json({ semesters: [semester] }),
      ),
    );
  }

  it('offers an Archive button for an active semester', async () => {
    mockBase(makeSemester({ id: semesterId, slug: 'fa26' }));
    render_();
    await waitFor(() =>
      expect(screen.getByTestId(`semester-archive-btn-${semesterId}`)).toBeInTheDocument(),
    );
  });

  it('clicking Archive reveals an explanation before confirming', async () => {
    mockBase(makeSemester({ id: semesterId, slug: 'fa26' }));
    render_();

    const btn = await screen.findByTestId(`semester-archive-btn-${semesterId}`);
    fireEvent.click(btn);

    expect(screen.getByTestId(`semester-archive-confirm-panel-${semesterId}`)).toBeInTheDocument();
    expect(screen.getByText(/can’t be undone/i)).toBeInTheDocument();
  });

  it('confirming POSTs to /semesters/:id/archive', async () => {
    let archived = false;
    mockBase(makeSemester({ id: semesterId, slug: 'fa26' }));
    mswServer.use(
      http.post(`/api/v1/semesters/${semesterId}/archive`, () => {
        archived = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    render_();

    fireEvent.click(await screen.findByTestId(`semester-archive-btn-${semesterId}`));
    fireEvent.click(screen.getByTestId(`semester-archive-confirm-${semesterId}`));

    await waitFor(() => expect(archived).toBe(true), { timeout: 3000 });
  });

  it('an already-archived semester shows the archived status and no Archive button', async () => {
    mockBase(makeSemester({ id: semesterId, slug: 'fa26', archived: true }));
    render_();

    await waitFor(() => expect(screen.getByText('archived')).toBeInTheDocument());
    expect(screen.queryByTestId(`semester-archive-btn-${semesterId}`)).not.toBeInTheDocument();
  });
});
