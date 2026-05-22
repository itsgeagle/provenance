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
import { DEFAULT_SEMESTER_SLUG, assignmentsHandler } from '../../test/msw-handlers.js';
import { AssignmentsView } from './AssignmentsView.js';
import { http, HttpResponse } from 'msw';
import { DEFAULT_SEMESTER_ID } from '../../test/msw-handlers.js';

function renderAssignmentsView() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/s/${DEFAULT_SEMESTER_SLUG}/assignments`]}>
        <Routes>
          <Route path="/s/:semesterSlug/assignments" element={<AssignmentsView />} />
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
});
