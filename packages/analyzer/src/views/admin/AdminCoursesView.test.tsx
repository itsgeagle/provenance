/**
 * AdminCoursesView — archive-confirmation tests.
 *
 * Archiving a course cascades to its semesters and is irreversible, so the
 * Archive action must explain the consequences before it fires. These tests pin
 * that affordance: the per-row Archive button reveals an explanation panel, and
 * confirming POSTs to /courses/:id/archive.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { mswServer } from '../../test-setup.js';
import { AdminCoursesView } from './AdminCoursesView.js';

const COURSE_ID = 'cc000000-0000-0000-0000-000000000001';

function makeCourse(overrides: Partial<{ archived: boolean }> = {}) {
  return {
    id: COURSE_ID,
    name: 'CS 61A',
    slug: 'cs61a',
    archived: overrides.archived ?? false,
    semesters_count: 2,
  };
}

function render_() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/admin/courses']}>
        <AdminCoursesView />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('AdminCoursesView — archive', () => {
  it('clicking Archive reveals an explanation that mentions the semester cascade', async () => {
    mswServer.use(
      http.get('/api/v1/courses', () => HttpResponse.json({ courses: [makeCourse()] })),
    );
    render_();

    fireEvent.click(await screen.findByTestId(`archive-btn-${COURSE_ID}`));

    expect(screen.getByTestId(`archive-confirm-panel-${COURSE_ID}`)).toBeInTheDocument();
    expect(screen.getByText(/all of its semesters/i)).toBeInTheDocument();
    expect(screen.getByText(/can’t be undone/i)).toBeInTheDocument();
  });

  it('confirming POSTs to /courses/:id/archive', async () => {
    let archived = false;
    mswServer.use(
      http.get('/api/v1/courses', () => HttpResponse.json({ courses: [makeCourse()] })),
      http.post(`/api/v1/courses/${COURSE_ID}/archive`, () => {
        archived = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    render_();

    fireEvent.click(await screen.findByTestId(`archive-btn-${COURSE_ID}`));
    fireEvent.click(screen.getByTestId(`archive-confirm-${COURSE_ID}`));

    await waitFor(() => expect(archived).toBe(true), { timeout: 3000 });
  });

  it('an archived course shows no Archive button', async () => {
    mswServer.use(
      http.get('/api/v1/courses', () =>
        HttpResponse.json({ courses: [makeCourse({ archived: true })] }),
      ),
    );
    render_();

    await waitFor(() => expect(screen.getByText('archived')).toBeInTheDocument());
    expect(screen.queryByTestId(`archive-btn-${COURSE_ID}`)).not.toBeInTheDocument();
  });
});
