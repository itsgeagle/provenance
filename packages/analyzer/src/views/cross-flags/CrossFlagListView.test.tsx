/**
 * CrossFlagListView tests — Phase 24.
 *
 * Tests:
 * 1. Renders list of cross-flags.
 * 2. Shows empty state when no flags.
 * 3. Clicking a row navigates to detail page.
 * 4. Applying heuristic_id filter triggers refetch with param.
 * 5. Applying severity_min filter triggers refetch.
 * 6. Load-more button fetches next page.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { mswServer } from '../../test-setup.js';
import { CrossFlagListView } from './CrossFlagListView.js';
import { DEFAULT_SEMESTER_ID, DEFAULT_SEMESTER_SLUG } from '../../test/msw-handlers.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCrossFlag(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'cf000000-0000-0000-0000-000000000001',
    heuristic_id: 'paste_shared_across_students',
    severity: 'high',
    confidence: 0.9,
    detail: null,
    participants: [
      {
        submission_id: 'aa000000-0000-0000-0000-000000000001',
        student: {
          id: '30000000-0000-0000-0000-000000000001',
          sid: '3031234',
          display_name: 'Alice',
        },
        assignment: { id: '20000000-0000-0000-0000-000000000001', assignment_id_str: 'hw1' },
        supporting_seqs: [1, 2, 3],
      },
      {
        submission_id: 'bb000000-0000-0000-0000-000000000001',
        student: {
          id: '30000000-0000-0000-0000-000000000002',
          sid: '3032345',
          display_name: 'Bob',
        },
        assignment: { id: '20000000-0000-0000-0000-000000000001', assignment_id_str: 'hw1' },
        supporting_seqs: [4, 5, 6],
      },
    ],
    created_at: '2025-01-10T12:00:00.000Z',
    ...overrides,
  };
}

function setupListHandler(items: object[] = [], nextCursor: string | null = null) {
  mswServer.use(
    http.get(`/api/v1/semesters/${DEFAULT_SEMESTER_ID}/cross-flags`, () =>
      HttpResponse.json({ items, next_cursor: nextCursor }),
    ),
    http.get('/api/v1/me', () =>
      HttpResponse.json({
        principal_kind: 'session',
        user: {
          id: '00000000-0000-0000-0000-000000000001',
          email: 'ta@berkeley.edu',
          display_name: 'Test TA',
          is_superadmin: false,
          created_at: '2025-01-01T00:00:00.000Z',
          last_login_at: null,
        },
        memberships: [
          {
            semester_id: DEFAULT_SEMESTER_ID,
            semester_slug: DEFAULT_SEMESTER_SLUG,
            course_slug: 'cs61a',
            role: 'admin',
            granted_at: '2025-01-01T00:00:00.000Z',
          },
        ],
      }),
    ),
  );
}

function renderListView() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/s/${DEFAULT_SEMESTER_SLUG}/cross-flags`]}>
        <Routes>
          <Route path="/s/:semesterSlug/cross-flags" element={<CrossFlagListView />} />
          <Route
            path="/s/:semesterSlug/cross-flags/:crossFlagId"
            element={<div data-testid="detail-page" />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CrossFlagListView', () => {
  it('renders cross-flag rows', async () => {
    setupListHandler([makeCrossFlag()]);
    renderListView();

    await waitFor(
      () => {
        expect(
          screen.getByTestId('cross-flag-row-cf000000-0000-0000-0000-000000000001'),
        ).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
    expect(screen.getByText('paste_shared_across_students')).toBeInTheDocument();
  });

  it('shows empty state when no flags', async () => {
    setupListHandler([]);
    renderListView();

    await waitFor(() => {
      expect(screen.getByText(/No cross-flags found/)).toBeInTheDocument();
    });
  });

  it('clicking a row navigates to detail page', async () => {
    setupListHandler([makeCrossFlag()]);
    renderListView();

    await waitFor(() => {
      expect(
        screen.getByTestId('cross-flag-row-cf000000-0000-0000-0000-000000000001'),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('cross-flag-row-cf000000-0000-0000-0000-000000000001'));

    await waitFor(() => {
      expect(screen.getByTestId('detail-page')).toBeInTheDocument();
    });
  });

  it('apply filters button triggers refetch', async () => {
    let requestedUrl = '';
    mswServer.use(
      http.get(`/api/v1/semesters/${DEFAULT_SEMESTER_ID}/cross-flags`, ({ request }) => {
        requestedUrl = request.url;
        return HttpResponse.json({ items: [], next_cursor: null });
      }),
    );
    renderListView();

    await waitFor(() => {
      expect(screen.getByTestId('cross-flag-filters')).toBeInTheDocument();
    });

    // Type a heuristic_id filter
    fireEvent.change(screen.getByTestId('filter-heuristic-id'), {
      target: { value: 'editing_pattern_clone' },
    });

    // Apply
    fireEvent.click(screen.getByTestId('apply-filters-btn'));

    await waitFor(() => {
      // URL should contain heuristic_id param
      expect(requestedUrl).toContain('heuristic_id=editing_pattern_clone');
    });
  });

  it('severity_min filter is sent as query param', async () => {
    let requestedUrl = '';
    mswServer.use(
      http.get(`/api/v1/semesters/${DEFAULT_SEMESTER_ID}/cross-flags`, ({ request }) => {
        requestedUrl = request.url;
        return HttpResponse.json({ items: [], next_cursor: null });
      }),
    );
    renderListView();

    await waitFor(() => {
      expect(screen.getByTestId('filter-severity-min')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId('filter-severity-min'), {
      target: { value: 'high' },
    });
    fireEvent.click(screen.getByTestId('apply-filters-btn'));

    await waitFor(() => {
      expect(requestedUrl).toContain('severity_min=high');
    });
  });

  it('shows load-more button when next_cursor exists', async () => {
    setupListHandler([makeCrossFlag()], 'cursor-abc');
    renderListView();

    await waitFor(() => {
      expect(screen.getByTestId('load-more-btn')).toBeInTheDocument();
    });
  });
});
