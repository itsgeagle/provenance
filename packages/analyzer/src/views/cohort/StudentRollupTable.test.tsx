/**
 * StudentRollupTable a11y tests (WCAG 2.1.1 Keyboard, 4.1.2 Name/Role/Value).
 *
 * Covers:
 * - Sortable column headers expose `aria-sort` and are keyboard-operable via
 *   the SortableHeader button.
 * - Existing render/virtualization/infinite-scroll behavior is unaffected.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  makeStudentRollupRow,
  DEFAULT_COURSE_SLUG,
  DEFAULT_SEMESTER_SLUG,
} from '../../test/msw-handlers.js';
import { StudentRollupTable } from './StudentRollupTable.js';
import type { StudentSort } from '../../api/queries.js';

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

function renderStudentRollupTable(
  props: Partial<React.ComponentProps<typeof StudentRollupTable>> = {},
) {
  const qc = makeQueryClient();
  const defaultProps: React.ComponentProps<typeof StudentRollupTable> = {
    rows: [],
    sort: 'score_sum_desc',
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
            element={<StudentRollupTable {...defaultProps} {...props} />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StudentRollupTable sortable headers (WCAG 2.1.1 / 4.1.2)', () => {
  it('exposes aria-sort on the currently-sorted column header', () => {
    renderStudentRollupTable({ sort: 'score_sum_desc' });
    const scoreHeader = screen.getByRole('columnheader', { name: /Score Sum/ });
    expect(scoreHeader).toHaveAttribute('aria-sort', 'descending');
  });

  it('exposes aria-sort="none" on a column that is not the active sort', () => {
    renderStudentRollupTable({ sort: 'score_sum_desc' });
    const studentHeader = screen.getByRole('columnheader', { name: /Student/ });
    expect(studentHeader).toHaveAttribute('aria-sort', 'none');
  });

  it('exposes aria-sort="ascending" for the student column when sorted by student', () => {
    renderStudentRollupTable({ sort: 'student_asc' });
    const studentHeader = screen.getByRole('columnheader', { name: /Student/ });
    expect(studentHeader).toHaveAttribute('aria-sort', 'ascending');
  });

  it('sorts on keyboard activation of the header button', () => {
    const onSortChange = vi.fn();
    renderStudentRollupTable({ sort: 'score_sum_desc', onSortChange });

    const button = screen.getByRole('button', { name: 'Student' });
    button.focus();
    expect(button).toHaveFocus();
    button.click();

    expect(onSortChange).toHaveBeenCalledTimes(1);
    expect(onSortChange).toHaveBeenCalledWith('student_asc' satisfies StudentSort);
  });

  it('does not call onSortChange when activating the header already driving the sort', () => {
    const onSortChange = vi.fn();
    renderStudentRollupTable({ sort: 'score_max_desc', onSortChange });

    const button = screen.getByRole('button', { name: /Score Max/ });
    button.click();

    expect(onSortChange).not.toHaveBeenCalled();
  });

  it('does not render a sortable header for the non-sortable Submissions column', () => {
    renderStudentRollupTable();
    const countHeader = screen.getByRole('columnheader', { name: /Submissions/ });
    expect(countHeader).not.toHaveAttribute('aria-sort');
    expect(screen.queryByRole('button', { name: /Submissions/ })).not.toBeInTheDocument();
  });
});

describe('StudentRollupTable existing behavior preserved', () => {
  it('renders the table scroll container and row data', async () => {
    const row = makeStudentRollupRow({
      student: {
        id: '30000000-0000-0000-0000-000000000042',
        sid: '3039999',
        display_name: 'Grace Hopper',
      },
    });
    renderStudentRollupTable({ rows: [row] });

    expect(screen.getByTestId('student-table-scroll')).toBeInTheDocument();
    await screen.findByText('Grace Hopper');
  });

  it('shows the infinite-scroll sentinel when nextCursor is non-null', () => {
    renderStudentRollupTable({ nextCursor: 'cursor-abc' });
    expect(screen.getByTestId('student-load-more-sentinel')).toBeInTheDocument();
  });

  it('does not show the sentinel when nextCursor is null', () => {
    renderStudentRollupTable({ nextCursor: null });
    expect(screen.queryByTestId('student-load-more-sentinel')).not.toBeInTheDocument();
  });
});
