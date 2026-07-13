/**
 * useActiveSemester resolves the active semester from BOTH the course slug and
 * the semester slug in the URL.
 *
 * Semester slugs are unique only within a course (DB constraint
 * semesters_course_id_slug_key on (course_id, slug)). Two semesters in
 * different courses may legitimately share a slug (e.g. both "sp25"). The old
 * single-key lookup `find(s => s.semester_slug === semesterSlug)` returned the
 * FIRST match, so a shared slug silently resolved to the wrong course's data.
 * These tests pin the course-qualified resolution.
 */

import type { ReactNode } from 'react';
import { describe, it, expect } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Membership } from '@provenance/shared/api-schemas';
import { mswServer } from '../test-setup.js';
import { meWithMembershipsHandler } from '../test/msw-handlers.js';
import { useActiveSemester } from './use-active-semester.js';

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

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
}

function renderActiveSemester(initialPath: string, memberships: Membership[]) {
  mswServer.use(meWithMembershipsHandler(memberships));
  const qc = makeQueryClient();
  return renderHook(() => useActiveSemester(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[initialPath]}>
          <Routes>
            <Route path="/s/:courseSlug/:semesterSlug/*" element={<>{children}</>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    ),
  });
}

describe('useActiveSemester', () => {
  it('resolves the semester matching BOTH course and semester slug', async () => {
    const { result } = renderActiveSemester('/s/cs61b/sp25', [SP25_IN_CS61A, SP25_IN_CS61B]);

    await waitFor(() => expect(result.current.semesterId).not.toBe(''));

    // cs61b's sp25, NOT cs61a's sp25 (which is first in the list).
    expect(result.current.semesterId).toBe(SP25_IN_CS61B.semester_id);
    expect(result.current.membership).toEqual(SP25_IN_CS61B);
    expect(result.current.courseSlug).toBe('cs61b');
    expect(result.current.semesterSlug).toBe('sp25');
  });

  it('builds a course-qualified basePath', async () => {
    const { result } = renderActiveSemester('/s/cs61a/sp25', [SP25_IN_CS61A, SP25_IN_CS61B]);

    await waitFor(() => expect(result.current.semesterId).not.toBe(''));

    expect(result.current.basePath).toBe('/s/cs61a/sp25');
  });

  it('returns no membership when course+slug pair does not match any membership', async () => {
    const { result } = renderActiveSemester('/s/cs70/sp25', [SP25_IN_CS61A, SP25_IN_CS61B]);

    // Let the /me query settle.
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.membership).toBeUndefined();
    expect(result.current.semesterId).toBe('');
  });
});
