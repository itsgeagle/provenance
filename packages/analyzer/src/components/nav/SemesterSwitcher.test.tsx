/**
 * SemesterSwitcher tests.
 *
 * Regression for the same-slug bug: two semesters in different courses may
 * share a slug (e.g. both "sp25"). The switcher must render them as two
 * DISTINCT options and switching must navigate to the course-qualified path
 * of the chosen semester — not collapse them into one ambiguous choice.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Membership } from '@provenance/shared/api-schemas';
import { mswServer } from '../../test-setup.js';
import { meWithMembershipsHandler } from '../../test/msw-handlers.js';
import { SemesterSwitcher } from './SemesterSwitcher.js';

const SP25_IN_CS61A: Membership = {
  semester_id: '00000000-0000-0000-0000-0000000000a1',
  semester_slug: 'sp25',
  semester_display_name: 'Spring 2025',
  course_slug: 'cs61a',
  course_name: 'CS 61A',
  role: 'admin',
  granted_at: '2025-01-01T00:00:00.000Z',
};

const SP25_IN_CS61B: Membership = {
  semester_id: '00000000-0000-0000-0000-0000000000b1',
  semester_slug: 'sp25',
  semester_display_name: 'Spring 2025',
  course_slug: 'cs61b',
  course_name: 'CS 61B',
  role: 'grader',
  granted_at: '2025-01-01T00:00:00.000Z',
};

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function renderSwitcher(initialPath: string, memberships: Membership[]) {
  mswServer.use(meWithMembershipsHandler(memberships));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route
            path="/s/:courseSlug/:semesterSlug/*"
            element={
              <>
                <SemesterSwitcher />
                <LocationProbe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('SemesterSwitcher', () => {
  it('renders two same-slug semesters as distinct options', async () => {
    renderSwitcher('/s/cs61a/sp25/roster', [SP25_IN_CS61A, SP25_IN_CS61B]);

    const select = await screen.findByTestId('semester-switcher');
    const options = select.querySelectorAll('option');

    expect(options).toHaveLength(2);
    // Options are valued by semester_id, so the two same-slug semesters are
    // distinct selectable choices.
    expect(options[0]!.value).toBe(SP25_IN_CS61A.semester_id);
    expect(options[1]!.value).toBe(SP25_IN_CS61B.semester_id);
    // Active selection reflects the URL's course, not just the slug.
    expect((select as HTMLSelectElement).value).toBe(SP25_IN_CS61A.semester_id);
  });

  it('switching to a same-slug semester navigates to the correct course, preserving the sub-path', async () => {
    renderSwitcher('/s/cs61a/sp25/roster', [SP25_IN_CS61A, SP25_IN_CS61B]);

    const select = await screen.findByTestId('semester-switcher');
    fireEvent.change(select, { target: { value: SP25_IN_CS61B.semester_id } });

    await waitFor(() => {
      expect(screen.getByTestId('location').textContent).toBe('/s/cs61b/sp25/roster');
    });
  });
});
