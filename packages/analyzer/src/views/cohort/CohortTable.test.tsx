/**
 * CohortTable a11y tests (WCAG 2.1.1 Keyboard, 4.1.2 Name/Role/Value).
 *
 * Covers:
 * - A submission row is reachable as a `link` with the correct `href` and an
 *   accessible name derived from the student's display name (Task 7).
 * - Sortable column headers expose `aria-sort` and are keyboard-operable via
 *   the SortableHeader button.
 * - The score-severity dot has a non-color text alternative.
 * - Virtualization + infinite-scroll sentinel behavior is unaffected.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  makeSubmissionRow,
  DEFAULT_COURSE_SLUG,
  DEFAULT_SEMESTER_SLUG,
} from '../../test/msw-handlers.js';
import { CohortTable } from './CohortTable.js';
import type { CohortSort } from '../../api/queries.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, retryDelay: 0 },
    },
  });
}

function renderCohortTable(props: Partial<React.ComponentProps<typeof CohortTable>> = {}) {
  const qc = makeQueryClient();
  const defaultProps: React.ComponentProps<typeof CohortTable> = {
    rows: [],
    sort: 'score_desc',
    onSortChange: vi.fn(),
    nextCursor: null,
    onLoadMore: vi.fn(),
    isLoadingMore: false,
  };
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/s/${DEFAULT_COURSE_SLUG}/${DEFAULT_SEMESTER_SLUG}`]}>
        <Routes>
          <Route
            path="/s/:courseSlug/:semesterSlug"
            element={<CohortTable {...defaultProps} {...props} />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CohortTable keyboard drill-in (WCAG 2.1.1)', () => {
  it('exposes a submission row as a link with the correct href and an accessible name', async () => {
    const row = makeSubmissionRow({
      id: '10000000-0000-0000-0000-000000000042',
      student: {
        id: '30000000-0000-0000-0000-000000000042',
        sid: '3039999',
        display_name: 'Grace Hopper',
      },
    });

    renderCohortTable({ rows: [row] });

    const link = await screen.findByRole('link', { name: /Grace Hopper/ });
    expect(link).toHaveAttribute(
      'href',
      `/s/${DEFAULT_COURSE_SLUG}/${DEFAULT_SEMESTER_SLUG}/sub/10000000-0000-0000-0000-000000000042`,
    );
  });

  it('does not use a mouse-only onClick handler on the <tr>', async () => {
    const row = makeSubmissionRow({ id: '10000000-0000-0000-0000-000000000042' });
    renderCohortTable({ rows: [row] });

    await screen.findByTestId('cohort-row-10000000-0000-0000-0000-000000000042');
    const tr = screen.getByTestId('cohort-row-10000000-0000-0000-0000-000000000042');
    // No click-handling role/cursor hack left on the row itself.
    expect(tr).not.toHaveAttribute('onclick');
    expect(tr.className).not.toContain('cursor-pointer');
  });
});

describe('CohortTable top-flag chips drill-in', () => {
  it('renders each top-flag chip as a link to that flag on the submission overview', async () => {
    const row = makeSubmissionRow({
      id: '10000000-0000-0000-0000-000000000042',
      top_flags: [{ heuristic_id: 'large_paste', severity: 'high' }],
    });
    renderCohortTable({ rows: [row] });

    const chip = await screen.findByRole('link', { name: /large paste/i });
    expect(chip).toHaveAttribute(
      'href',
      `/s/${DEFAULT_COURSE_SLUG}/${DEFAULT_SEMESTER_SLUG}/sub/10000000-0000-0000-0000-000000000042?tab=overview&flag=large_paste`,
    );
  });

  it('renders an em dash rather than a link when a row has no top flags', async () => {
    const row = makeSubmissionRow({
      id: '10000000-0000-0000-0000-000000000043',
      top_flags: [],
    });
    renderCohortTable({ rows: [row] });

    await screen.findByTestId('cohort-row-10000000-0000-0000-0000-000000000043');
    // The only link in the row is the student drill-in, not a flag chip.
    expect(screen.queryByRole('link', { name: /paste|edit|flag/i })).not.toBeInTheDocument();
  });
});

describe('CohortTable sortable headers (WCAG 2.1.1 / 4.1.2)', () => {
  it('exposes aria-sort on the currently-sorted column header', () => {
    renderCohortTable({ sort: 'score_desc' });
    const scoreHeader = screen.getByRole('columnheader', { name: /Score/ });
    expect(scoreHeader).toHaveAttribute('aria-sort', 'descending');
  });

  it('exposes aria-sort="none" on a column that is not the active sort', () => {
    renderCohortTable({ sort: 'score_desc' });
    const studentHeader = screen.getByRole('columnheader', { name: /Student/ });
    expect(studentHeader).toHaveAttribute('aria-sort', 'none');
  });

  it('sorts on keyboard activation of the header button', () => {
    const onSortChange = vi.fn();
    renderCohortTable({ sort: 'score_desc', onSortChange });

    const button = screen.getByRole('button', { name: 'Student' });
    button.focus();
    expect(button).toHaveFocus();
    fireEvent.click(button);

    expect(onSortChange).toHaveBeenCalledTimes(1);
    expect(onSortChange).toHaveBeenCalledWith('student_desc');
  });

  it('toggles from desc to asc when the currently-sorted column header is activated again', () => {
    const onSortChange = vi.fn();
    renderCohortTable({ sort: 'score_desc' as CohortSort, onSortChange });

    const button = screen.getByRole('button', { name: /Score/ });
    fireEvent.click(button);

    expect(onSortChange).toHaveBeenCalledWith('score_asc');
  });
});

describe('CohortTable score-severity dot text alternative', () => {
  it('gives the severity dot a role and aria-label instead of color+title only', async () => {
    const row = makeSubmissionRow({
      id: '10000000-0000-0000-0000-000000000042',
      score_max_severity: 'high',
    });
    renderCohortTable({ rows: [row] });

    const dot = await screen.findByRole('img', { name: /Max severity: high/ });
    expect(dot).toBeInTheDocument();
  });
});

describe('CohortTable existing behavior preserved', () => {
  it('renders the table scroll container and row data', async () => {
    const row = makeSubmissionRow({ id: '10000000-0000-0000-0000-000000000042' });
    renderCohortTable({ rows: [row] });

    expect(screen.getByTestId('cohort-table-scroll')).toBeInTheDocument();
    await screen.findByText(row.student.display_name);
  });

  it('shows the infinite-scroll sentinel when nextCursor is non-null', () => {
    renderCohortTable({ nextCursor: 'cursor-abc' });
    expect(screen.getByTestId('cohort-load-more-sentinel')).toBeInTheDocument();
  });

  it('does not show the sentinel when nextCursor is null', () => {
    renderCohortTable({ nextCursor: null });
    expect(screen.queryByTestId('cohort-load-more-sentinel')).not.toBeInTheDocument();
  });
});
