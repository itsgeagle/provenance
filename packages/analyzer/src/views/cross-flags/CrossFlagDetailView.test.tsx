/**
 * CrossFlagDetailView tests — Phase 24.
 *
 * Tests:
 * 1. Renders cross-flag detail with participants.
 * 2. Renders heuristic ID, severity badge, confidence.
 * 3. Renders each participant with student display name and supporting seqs.
 * 4. Shows error state on fetch failure.
 * 5. Back link navigates to list.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { mswServer } from '../../test-setup.js';
import { CrossFlagDetailView } from './CrossFlagDetailView.js';
import { DEFAULT_SEMESTER_SLUG } from '../../test/msw-handlers.js';

const CROSS_FLAG_ID = 'cf000000-0000-0000-0000-000000000001';

const DETAIL_FIXTURE = {
  item: {
    id: CROSS_FLAG_ID,
    heuristic_id: 'paste_shared_across_students',
    severity: 'high',
    confidence: 0.92,
    detail: { match_ratio: 0.85 },
    participants: [
      {
        submission_id: 'aa000000-0000-0000-0000-000000000001',
        student: {
          id: '30000000-0000-0000-0000-000000000001',
          sid: '3031234',
          display_name: 'Alice Liddell',
        },
        assignment: { id: '20000000-0000-0000-0000-000000000001', assignment_id_str: 'hw1' },
        supporting_seqs: [100, 101, 102],
      },
      {
        submission_id: 'bb000000-0000-0000-0000-000000000001',
        student: {
          id: '30000000-0000-0000-0000-000000000002',
          sid: '3032345',
          display_name: 'Bob Builder',
        },
        assignment: { id: '20000000-0000-0000-0000-000000000001', assignment_id_str: 'hw1' },
        supporting_seqs: [200, 201, 202],
      },
    ],
    created_at: '2025-01-10T12:00:00.000Z',
  },
};

function setupDetailHandler(status = 200, body: object = DETAIL_FIXTURE) {
  mswServer.use(
    http.get(`/api/v1/cross-flags/${CROSS_FLAG_ID}`, () => HttpResponse.json(body, { status })),
  );
}

function renderDetailView() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/s/${DEFAULT_SEMESTER_SLUG}/cross-flags/${CROSS_FLAG_ID}`]}>
        <Routes>
          <Route
            path="/s/:semesterSlug/cross-flags/:crossFlagId"
            element={<CrossFlagDetailView />}
          />
          <Route path="/s/:semesterSlug/cross-flags" element={<div data-testid="list-page" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CrossFlagDetailView', () => {
  it('renders cross-flag heuristic, severity, and confidence', async () => {
    setupDetailHandler();
    renderDetailView();

    await waitFor(() => {
      expect(screen.getByTestId('cross-flag-detail-view')).toBeInTheDocument();
    });

    expect(screen.getByText('paste_shared_across_students')).toBeInTheDocument();
    expect(screen.getByText('high')).toBeInTheDocument();
    expect(screen.getByText(/92%/)).toBeInTheDocument();
  });

  it('renders both participants', async () => {
    setupDetailHandler();
    renderDetailView();

    await waitFor(() => {
      expect(screen.getByTestId('cross-flag-detail-view')).toBeInTheDocument();
    });

    expect(
      screen.getByTestId('participant-aa000000-0000-0000-0000-000000000001'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('participant-bb000000-0000-0000-0000-000000000001'),
    ).toBeInTheDocument();
    expect(screen.getByText('Alice Liddell')).toBeInTheDocument();
    expect(screen.getByText('Bob Builder')).toBeInTheDocument();
  });

  it('renders supporting seqs per participant', async () => {
    setupDetailHandler();
    renderDetailView();

    await waitFor(() => {
      expect(screen.getByTestId('participants-grid')).toBeInTheDocument();
    });

    // Alice's supporting seqs
    expect(screen.getByText(/100, 101, 102/)).toBeInTheDocument();
  });

  it('shows error state on fetch failure', async () => {
    setupDetailHandler(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    renderDetailView();

    await waitFor(() => {
      expect(screen.getByTestId('cross-flag-detail-error')).toBeInTheDocument();
    });
  });

  it('back link navigates to cross-flags list', async () => {
    setupDetailHandler();
    renderDetailView();

    await waitFor(() => {
      expect(screen.getByTestId('back-to-list')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('back-to-list'));

    await waitFor(() => {
      expect(screen.getByTestId('list-page')).toBeInTheDocument();
    });
  });
});
