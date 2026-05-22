/**
 * MSW request handlers for analyzer tests.
 *
 * These handlers mock the Provenance API endpoints at the network layer.
 * Tests that need different responses should use server.use() to override
 * specific handlers for the duration of that test.
 */

import { http, HttpResponse } from 'msw';
import type {
  Membership,
  SubmissionRow,
  CohortFacets,
  StudentRollupRow,
} from '@provenance/shared/api-schemas';

// ---------------------------------------------------------------------------
// Default response fixtures
// ---------------------------------------------------------------------------

export const defaultUser = {
  id: '00000000-0000-0000-0000-000000000001',
  email: 'ta@berkeley.edu',
  display_name: 'Test TA',
  is_superadmin: false,
  created_at: '2025-01-01T00:00:00.000Z',
  last_login_at: '2025-01-15T10:00:00.000Z',
} as const;

export const defaultMembership = {
  semester_id: '00000000-0000-0000-0000-000000000010',
  semester_slug: 'sp25',
  course_slug: 'cs61a',
  role: 'admin' as const,
  granted_at: '2025-01-01T00:00:00.000Z',
};

export const defaultMeResponse = {
  principal_kind: 'session' as const,
  user: defaultUser,
  memberships: [defaultMembership],
};

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export const handlers = [
  // GET /api/v1/me — returns authenticated user with one semester
  http.get('/api/v1/me', () => {
    return HttpResponse.json(defaultMeResponse);
  }),

  // POST /api/v1/auth/logout — returns 204
  http.post('/api/v1/auth/logout', () => {
    return new HttpResponse(null, { status: 204 });
  }),
];

// ---------------------------------------------------------------------------
// Helper factories for per-test overrides
// ---------------------------------------------------------------------------

/** Returns a /me handler that responds with 401 (not authenticated). */
export function meUnauthorizedHandler() {
  return http.get('/api/v1/me', () => {
    return HttpResponse.json(
      {
        error: {
          code: 'AUTH_REQUIRED',
          message: 'Authentication required',
        },
      },
      { status: 401 },
    );
  });
}

/** Returns a /me handler that responds with empty memberships. */
export function meNoSemestersHandler() {
  return http.get('/api/v1/me', () => {
    return HttpResponse.json({
      ...defaultMeResponse,
      memberships: [],
    });
  });
}

/** Returns a /me handler that responds with the given memberships. */
export function meWithMembershipsHandler(memberships: Membership[]) {
  return http.get('/api/v1/me', () => {
    return HttpResponse.json({
      ...defaultMeResponse,
      memberships,
    });
  });
}

// ---------------------------------------------------------------------------
// Cohort fixture factories (Phase 21)
// ---------------------------------------------------------------------------

export const DEFAULT_SEMESTER_ID = defaultMembership.semester_id;
export const DEFAULT_SEMESTER_SLUG = defaultMembership.semester_slug;

export function makeSubmissionRow(overrides: Partial<SubmissionRow> = {}): SubmissionRow {
  const base: SubmissionRow = {
    id: '10000000-0000-0000-0000-000000000001',
    semester_id: DEFAULT_SEMESTER_ID,
    assignment: {
      id: '20000000-0000-0000-0000-000000000001',
      assignment_id_str: 'hw1',
      label: 'Homework 1',
    },
    student: {
      id: '30000000-0000-0000-0000-000000000001',
      sid: '3031234',
      display_name: 'Alice Liddell',
    },
    score_total: 5.0,
    score_max_severity: 'medium',
    flag_counts: { info: 1, low: 2, medium: 1, high: 0 },
    top_flags: [{ heuristic_id: 'large_paste', severity: 'medium' }],
    validation_status: 'pass',
    ingested_at: '2025-01-10T12:00:00.000Z',
    recorder_version: '1.2.0',
    superseded: false,
    recompute_status: 'fresh',
  };
  // Merge overrides carefully: top-level fields override base, nested objects
  // (assignment, student, flag_counts) are replaced entirely if provided.
  return { ...base, ...overrides };
}

export const defaultFacets: CohortFacets = {
  by_severity: { info: 2, low: 3, medium: 1, high: 0 },
  by_validation: { pass: 4, warn: 1, fail: 0 },
  by_assignment: [{ id: '20000000-0000-0000-0000-000000000001', label: 'Homework 1', count: 5 }],
};

export function cohortSubmissionsHandler(
  items: SubmissionRow[],
  options: {
    next_cursor?: string | null;
    total_count?: number;
    facets?: CohortFacets;
  } = {},
) {
  return http.get(`/api/v1/semesters/${DEFAULT_SEMESTER_ID}/submissions`, () => {
    return HttpResponse.json({
      items,
      next_cursor: options.next_cursor ?? null,
      total_count: options.total_count ?? items.length,
      facets: options.facets ?? defaultFacets,
    });
  });
}

export function cohortStudentsHandler(
  items: StudentRollupRow[],
  options: { next_cursor?: string | null; total_count?: number } = {},
) {
  return http.get(`/api/v1/semesters/${DEFAULT_SEMESTER_ID}/students`, () => {
    return HttpResponse.json({
      items,
      next_cursor: options.next_cursor ?? null,
      total_count: options.total_count ?? items.length,
    });
  });
}

export function assignmentsHandler() {
  return http.get(`/api/v1/semesters/${DEFAULT_SEMESTER_ID}/assignments`, () => {
    return HttpResponse.json({
      items: [
        {
          id: '20000000-0000-0000-0000-000000000001',
          semester_id: DEFAULT_SEMESTER_ID,
          assignment_id_str: 'hw1',
          label: 'Homework 1',
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
    });
  });
}

export function makeStudentRollupRow(overrides: Partial<StudentRollupRow> = {}): StudentRollupRow {
  return {
    student: overrides.student ?? {
      id: '30000000-0000-0000-0000-000000000001',
      sid: '3031234',
      display_name: 'Alice Liddell',
    },
    submission_count: overrides.submission_count ?? 2,
    score_sum: overrides.score_sum ?? 10.0,
    score_max: overrides.score_max ?? 7.5,
    flag_counts: overrides.flag_counts ?? { info: 1, low: 2, medium: 1, high: 0 },
    worst_submission: overrides.worst_submission ?? makeSubmissionRow(),
    recompute_status: overrides.recompute_status ?? 'fresh',
  };
}
