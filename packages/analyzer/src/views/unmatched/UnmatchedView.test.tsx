/**
 * UnmatchedView tests.
 *
 * - Happy path: renders unmatched files table.
 * - Empty state: message when no unmatched files.
 * - Attach modal: opens on Attach click; shows student and assignment selectors.
 * - Discard: shows confirm step; calls API on confirm.
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
  unmatchedHandler,
  rosterHandler,
  assignmentsHandler,
  makeIngestFile,
} from '../../test/msw-handlers.js';
import { UnmatchedView } from './UnmatchedView.js';

const UNMATCHED_FILE_ID = 'ff000000-0000-0000-0000-000000000001';

function renderUnmatchedView() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/s/${DEFAULT_SEMESTER_SLUG}/unmatched`]}>
        <Routes>
          <Route path="/s/:semesterSlug/unmatched" element={<UnmatchedView />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('UnmatchedView', () => {
  it('shows empty state when no unmatched files', async () => {
    mswServer.use(unmatchedHandler([]));

    renderUnmatchedView();

    await waitFor(() => expect(screen.getByTestId('unmatched-empty')).toBeInTheDocument(), {
      timeout: 3000,
    });
  });

  it('renders unmatched files table', async () => {
    const file = makeIngestFile({ status: 'unmatched', original_filename: 'unknown.zip' });
    mswServer.use(unmatchedHandler([file]));

    renderUnmatchedView();

    await waitFor(() => expect(screen.getByTestId('unmatched-table')).toBeInTheDocument(), {
      timeout: 3000,
    });
    expect(screen.getByText('unknown.zip')).toBeInTheDocument();
  });

  it('opens attach modal on Attach click', async () => {
    const file = makeIngestFile({ id: UNMATCHED_FILE_ID, status: 'unmatched' });
    mswServer.use(
      unmatchedHandler([file]),
      rosterHandler(
        [
          {
            id: 'a2000000-0000-0000-0000-000000000001',
            sid: '3031234',
            display_name: 'Alice',
            email: null,
            extras: null,
          },
        ],
        1,
      ),
      assignmentsHandler(),
    );

    renderUnmatchedView();

    await waitFor(
      () => expect(screen.getByTestId(`attach-btn-${UNMATCHED_FILE_ID}`)).toBeInTheDocument(),
      { timeout: 3000 },
    );
    fireEvent.click(screen.getByTestId(`attach-btn-${UNMATCHED_FILE_ID}`));

    expect(screen.getByTestId('attach-modal')).toBeInTheDocument();
    // Should have student selector
    expect(screen.getByTestId('student-select')).toBeInTheDocument();
    expect(screen.getByTestId('assignment-select')).toBeInTheDocument();
  });

  it('calls discard API on confirm', async () => {
    const file = makeIngestFile({ id: UNMATCHED_FILE_ID, status: 'unmatched' });
    mswServer.use(unmatchedHandler([file]));

    let discardCalled = false;
    mswServer.use(
      http.post(
        `/api/v1/semesters/${DEFAULT_SEMESTER_ID}/unmatched/${UNMATCHED_FILE_ID}/discard`,
        () => {
          discardCalled = true;
          return HttpResponse.json({
            id: UNMATCHED_FILE_ID,
            original_filename: 'alice_hw1.zip',
            size_bytes: 1024,
            blob_sha256: 'abc',
            status: 'discarded',
          });
        },
      ),
    );

    renderUnmatchedView();

    await waitFor(
      () => expect(screen.getByTestId(`discard-btn-${UNMATCHED_FILE_ID}`)).toBeInTheDocument(),
      { timeout: 3000 },
    );
    fireEvent.click(screen.getByTestId(`discard-btn-${UNMATCHED_FILE_ID}`));
    await waitFor(
      () => expect(screen.getByTestId(`discard-confirm-${UNMATCHED_FILE_ID}`)).toBeInTheDocument(),
      { timeout: 3000 },
    );
    fireEvent.click(screen.getByTestId(`discard-confirm-${UNMATCHED_FILE_ID}`));

    await waitFor(() => expect(discardCalled).toBe(true), { timeout: 3000 });
  });
});
