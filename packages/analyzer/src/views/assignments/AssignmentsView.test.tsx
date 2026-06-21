/**
 * AssignmentsView tests.
 *
 * - Happy path: renders assignment rows.
 * - Inline edit: clicking a label shows the edit input.
 * - Empty state: message when no assignments.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { mswServer } from '../../test-setup.js';
import {
  DEFAULT_COURSE_SLUG,
  DEFAULT_SEMESTER_SLUG,
  assignmentsHandler,
} from '../../test/msw-handlers.js';
import { AssignmentsView } from './AssignmentsView.js';
import { http, HttpResponse } from 'msw';
import { DEFAULT_SEMESTER_ID } from '../../test/msw-handlers.js';

function renderAssignmentsView() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter
        initialEntries={[`/s/${DEFAULT_COURSE_SLUG}/${DEFAULT_SEMESTER_SLUG}/assignments`]}
      >
        <Routes>
          <Route path="/s/:courseSlug/:semesterSlug/assignments" element={<AssignmentsView />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('AssignmentsView', () => {
  it('renders assignment list', async () => {
    mswServer.use(assignmentsHandler());

    renderAssignmentsView();

    await waitFor(() => expect(screen.getByTestId('assignments-table')).toBeInTheDocument(), {
      timeout: 3000,
    });
    expect(screen.getByText('hw1')).toBeInTheDocument();
    expect(screen.getByText('Homework 1')).toBeInTheDocument();
  });

  it('shows empty state when no assignments', async () => {
    mswServer.use(
      http.get(`/api/v1/semesters/${DEFAULT_SEMESTER_ID}/assignments`, () =>
        HttpResponse.json({ items: [] }),
      ),
    );

    renderAssignmentsView();

    await waitFor(() => expect(screen.getByText(/No assignments yet/)).toBeInTheDocument(), {
      timeout: 3000,
    });
  });

  it('clicking a label shows inline edit input', async () => {
    mswServer.use(assignmentsHandler());

    renderAssignmentsView();

    await waitFor(() => expect(screen.getByTestId('assignments-table')).toBeInTheDocument(), {
      timeout: 3000,
    });
    // Wait for the actual data row to appear
    await waitFor(
      () =>
        expect(
          screen.getByTestId('label-20000000-0000-0000-0000-000000000001'),
        ).toBeInTheDocument(),
      { timeout: 3000 },
    );

    const labelBtn = screen.getByTestId('label-20000000-0000-0000-0000-000000000001');
    fireEvent.click(labelBtn);

    expect(
      screen.getByTestId('label-input-20000000-0000-0000-0000-000000000001'),
    ).toBeInTheDocument();
  });

  it('save sends PATCH and renders the new label after refetch', async () => {
    // Start with the default label; after PATCH, the list refetches with the
    // new label. We assert both that the request body has the trimmed label
    // and that the UI displays it after the mutation resolves.
    let observedBody: { label?: string } | null = null;
    let currentLabel = 'Homework 1';

    mswServer.use(
      http.get(`/api/v1/semesters/${DEFAULT_SEMESTER_ID}/assignments`, () =>
        HttpResponse.json({
          items: [
            {
              id: '20000000-0000-0000-0000-000000000001',
              semester_id: DEFAULT_SEMESTER_ID,
              assignment_id_str: 'hw1',
              label: currentLabel,
              sort_order: 1,
              submission_count: 5,
              distinct_students: 5,
              mean_score: 4.2,
              median_score: 4.5,
              p95_score: 8.0,
              fail_count: 0,
              warn_count: 1,
            },
          ],
        }),
      ),
      http.patch(
        `/api/v1/semesters/${DEFAULT_SEMESTER_ID}/assignments/20000000-0000-0000-0000-000000000001`,
        async ({ request }) => {
          observedBody = (await request.json()) as { label?: string };
          currentLabel = observedBody.label ?? currentLabel;
          return HttpResponse.json({
            assignment: {
              id: '20000000-0000-0000-0000-000000000001',
              semester_id: DEFAULT_SEMESTER_ID,
              assignment_id_str: 'hw1',
              label: currentLabel,
              sort_order: 1,
              submission_count: 5,
              distinct_students: 5,
              mean_score: 4.2,
              median_score: 4.5,
              p95_score: 8.0,
              fail_count: 0,
              warn_count: 1,
            },
          });
        },
      ),
    );

    renderAssignmentsView();

    await waitFor(() => expect(screen.getByText('Homework 1')).toBeInTheDocument(), {
      timeout: 3000,
    });

    fireEvent.click(screen.getByTestId('label-20000000-0000-0000-0000-000000000001'));
    const input = screen.getByTestId('label-input-20000000-0000-0000-0000-000000000001');
    fireEvent.change(input, { target: { value: 'Homework 1 — Renamed' } });
    fireEvent.click(screen.getByTestId('label-save-20000000-0000-0000-0000-000000000001'));

    await waitFor(() => expect(observedBody).not.toBeNull(), { timeout: 3000 });
    expect(observedBody!.label).toBe('Homework 1 — Renamed');

    await waitFor(() => expect(screen.getByText('Homework 1 — Renamed')).toBeInTheDocument(), {
      timeout: 3000,
    });
  });
});
