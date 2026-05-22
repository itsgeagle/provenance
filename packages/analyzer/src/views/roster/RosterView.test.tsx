/**
 * RosterView tests.
 *
 * - Happy path: renders roster entries table.
 * - Upload modal: shows after clicking "Upload CSV".
 * - Diff preview: shows correct counts after upload.
 * - Empty state: message when no roster entries.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { mswServer } from '../../test-setup.js';
import {
  DEFAULT_SEMESTER_ID,
  DEFAULT_SEMESTER_SLUG,
  rosterHandler,
} from '../../test/msw-handlers.js';
import { RosterView } from './RosterView.js';

function renderRosterView() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/s/${DEFAULT_SEMESTER_SLUG}/roster`]}>
        <Routes>
          <Route path="/s/:semesterSlug/roster" element={<RosterView />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('RosterView', () => {
  it('renders roster entries', async () => {
    mswServer.use(
      rosterHandler(
        [
          {
            id: 'a0000000-0000-0000-0000-000000000001',
            sid: '3031234',
            display_name: 'Alice Liddell',
            email: 'alice@b.edu',
            extras: null,
          },
          {
            id: 'a0000000-0000-0000-0000-000000000002',
            sid: '3031235',
            display_name: 'Bob Smith',
            email: null,
            extras: null,
          },
        ],
        2,
      ),
    );

    renderRosterView();

    await waitFor(() => expect(screen.getByTestId('roster-table')).toBeInTheDocument(), {
      timeout: 3000,
    });
    expect(screen.getByText('Alice Liddell')).toBeInTheDocument();
    expect(screen.getByText('3031234')).toBeInTheDocument();
    expect(screen.getByText('alice@b.edu')).toBeInTheDocument();
    expect(screen.getByText('Bob Smith')).toBeInTheDocument();
  });

  it('shows empty state when no roster entries', async () => {
    mswServer.use(rosterHandler([], 0));

    renderRosterView();

    await waitFor(() => expect(screen.getByText(/No roster entries/)).toBeInTheDocument(), {
      timeout: 3000,
    });
  });

  it('shows upload modal when "Upload CSV" is clicked', async () => {
    mswServer.use(rosterHandler([], 0));

    renderRosterView();

    await waitFor(() => expect(screen.getByTestId('upload-csv-btn')).toBeInTheDocument(), {
      timeout: 3000,
    });
    fireEvent.click(screen.getByTestId('upload-csv-btn'));

    expect(screen.getByTestId('upload-modal')).toBeInTheDocument();
  });

  it('shows diff preview with correct counts after upload', async () => {
    mswServer.use(
      rosterHandler([], 0),
      http.post(`/api/v1/semesters/${DEFAULT_SEMESTER_ID}/roster:upload`, () =>
        HttpResponse.json({
          upload_id: 'aa000000-0000-0000-0000-000000000001',
          parsed_rows: 30,
          to_add: 25,
          to_update: 3,
          to_delete: 2,
          errors: [],
        }),
      ),
    );

    renderRosterView();

    await waitFor(() => expect(screen.getByTestId('upload-csv-btn')).toBeInTheDocument(), {
      timeout: 3000,
    });
    fireEvent.click(screen.getByTestId('upload-csv-btn'));

    // Simulate CSV file upload by triggering the hidden input
    const file = new File(['sid,display_name\n3031234,Alice'], 'roster.csv', { type: 'text/csv' });
    const input = screen.getByTestId('csv-input');
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(screen.getByTestId('diff-preview')).toBeInTheDocument(), {
      timeout: 3000,
    });
    expect(screen.getByTestId('diff-to-add')).toHaveTextContent('+25');
    expect(screen.getByTestId('diff-to-update')).toHaveTextContent('3');
    expect(screen.getByTestId('diff-to-delete')).toHaveTextContent('−2');
  });
});
