/**
 * React-Query hooks for Provenance API endpoints.
 *
 * Phase 20 endpoints:
 * - GET /me  → useMe(), useSemesters() (semesters derive from /me memberships)
 * - POST /auth/logout → useLogout()
 *
 * Phase 21 endpoints:
 * - GET /semesters/:id/submissions → useCohortSubmissions()
 * - GET /semesters/:id/students    → useCohortStudents()
 * - GET /semesters/:id/assignments → useAssignments()
 *
 * Note: there is no /me/semesters endpoint. The server returns all memberships
 * inline in GET /me. useSemesters() re-uses the same /me query and maps the
 * memberships array to SemesterSummary objects.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch, UnauthorizedError } from './client.js';
import {
  MeResponseSchema,
  CohortListResponseSchema,
  StudentListResponseSchema,
  AssignmentListResponseSchema,
} from '@provenance/shared/api-schemas';
import type { Membership } from '@provenance/shared/api-schemas';

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

export const queryKeys = {
  me: ['me'] as const,
  cohortSubmissions: (semesterId: string, params: Record<string, unknown>) =>
    ['cohort', semesterId, 'submissions', params] as const,
  cohortStudents: (semesterId: string, params: Record<string, unknown>) =>
    ['cohort', semesterId, 'students', params] as const,
  assignments: (semesterId: string) => ['cohort', semesterId, 'assignments'] as const,
} as const;

// ---------------------------------------------------------------------------
// Retry helper
// ---------------------------------------------------------------------------

function noRetryOn401(failureCount: number, error: Error): boolean {
  if (error instanceof UnauthorizedError) return false;
  return failureCount < 2;
}

// ---------------------------------------------------------------------------
// useMe
// ---------------------------------------------------------------------------

/**
 * Fetches the authenticated principal from GET /me.
 *
 * Stale-time: 5 minutes. Auth errors (401) are NOT retried — they indicate
 * the user needs to log in.
 */
export function useMe() {
  return useQuery({
    queryKey: queryKeys.me,
    queryFn: () => apiFetch('/me', undefined, MeResponseSchema),
    staleTime: 5 * 60 * 1000, // 5 minutes
    retry: noRetryOn401,
  });
}

// ---------------------------------------------------------------------------
// useSemesters
// ---------------------------------------------------------------------------

/**
 * Returns the user's accessible semesters as memberships.
 *
 * This is NOT a separate API call: it re-uses the /me endpoint and returns
 * memberships directly.
 */
export function useSemesters() {
  return useQuery<Membership[], Error>({
    queryKey: [...queryKeys.me, 'semesters'],
    queryFn: async () => {
      const me = await apiFetch('/me', undefined, MeResponseSchema);
      return me.memberships;
    },
    staleTime: 5 * 60 * 1000,
    retry: noRetryOn401,
  });
}

// ---------------------------------------------------------------------------
// useLogout
// ---------------------------------------------------------------------------

/**
 * Mutation that posts to POST /auth/logout and invalidates the /me cache.
 *
 * On success the caller should navigate to /login.
 */
export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch('/auth/logout', {
        method: 'POST',
      }),
    onSuccess: () => {
      // Purge all cached data — user is no longer authenticated.
      queryClient.clear();
    },
  });
}

// ---------------------------------------------------------------------------
// CohortFilters + CohortSort types (mirrors server-side shape in list.ts)
// ---------------------------------------------------------------------------

export type CohortFilters = {
  assignmentId?: string;
  flagIds?: string[]; // multi-value; OR semantics
  severityMin?: 'info' | 'low' | 'medium' | 'high';
  validationStatus?: 'pass' | 'warn' | 'fail';
  scoreMin?: number;
  scoreMax?: number;
  hasExternalEdits?: boolean;
  hasLargePaste?: boolean;
  recorderVersion?: string;
  includeSuperseded?: boolean;
  q?: string;
};

export type CohortSort =
  | 'score_desc'
  | 'score_asc'
  | 'ingested_desc'
  | 'student_asc'
  | 'student_desc'
  | 'assignment_asc';

export type StudentSort = 'score_sum_desc' | 'score_max_desc' | 'student_asc';

// ---------------------------------------------------------------------------
// useCohortSubmissions
// ---------------------------------------------------------------------------

/**
 * Fetches a page of submissions for a semester with filters/sort/cursor.
 *
 * Calls GET /semesters/:semesterId/submissions with query params derived from
 * the filters, sort, cursor, and limit arguments.
 */
export function useCohortSubmissions(
  semesterId: string,
  filters: CohortFilters,
  sort: CohortSort = 'score_desc',
  cursor: string | null = null,
  limit = 50,
) {
  const params = buildSubmissionParams(filters, sort, cursor, limit);
  return useQuery({
    queryKey: queryKeys.cohortSubmissions(semesterId, params),
    queryFn: () => {
      const qs = buildQueryString(params);
      return apiFetch(
        `/semesters/${semesterId}/submissions${qs ? `?${qs}` : ''}`,
        undefined,
        CohortListResponseSchema,
      );
    },
    staleTime: 30 * 1000, // 30 seconds
    retry: noRetryOn401,
    enabled: semesterId !== '',
  });
}

// ---------------------------------------------------------------------------
// useCohortStudents
// ---------------------------------------------------------------------------

/**
 * Fetches the student-rollup rows for a semester.
 *
 * Calls GET /semesters/:semesterId/students.
 */
export function useCohortStudents(
  semesterId: string,
  filters: CohortFilters,
  sort: StudentSort = 'score_sum_desc',
  cursor: string | null = null,
  limit = 50,
) {
  const params = buildStudentParams(filters, sort, cursor, limit);
  return useQuery({
    queryKey: queryKeys.cohortStudents(semesterId, params),
    queryFn: () => {
      const qs = buildQueryString(params);
      return apiFetch(
        `/semesters/${semesterId}/students${qs ? `?${qs}` : ''}`,
        undefined,
        StudentListResponseSchema,
      );
    },
    staleTime: 30 * 1000,
    retry: noRetryOn401,
    enabled: semesterId !== '',
  });
}

// ---------------------------------------------------------------------------
// useAssignments
// ---------------------------------------------------------------------------

/**
 * Fetches the assignment list for a semester (for filter dropdown).
 *
 * Calls GET /semesters/:semesterId/assignments.
 */
export function useAssignments(semesterId: string) {
  return useQuery({
    queryKey: queryKeys.assignments(semesterId),
    queryFn: () =>
      apiFetch(`/semesters/${semesterId}/assignments`, undefined, AssignmentListResponseSchema),
    staleTime: 5 * 60 * 1000, // 5 minutes — assignments change infrequently
    retry: noRetryOn401,
    enabled: semesterId !== '',
  });
}

// ---------------------------------------------------------------------------
// Private helpers — param builders
// ---------------------------------------------------------------------------

type QueryParams = Record<string, string | string[] | undefined>;

function buildSubmissionParams(
  filters: CohortFilters,
  sort: CohortSort,
  cursor: string | null,
  limit: number,
): QueryParams {
  const p: QueryParams = { sort, limit: String(limit) };
  if (filters.assignmentId) p['assignment_id'] = filters.assignmentId;
  if (filters.flagIds?.length) p['flag_id'] = filters.flagIds;
  if (filters.severityMin) p['severity_min'] = filters.severityMin;
  if (filters.validationStatus) p['validation_status'] = filters.validationStatus;
  if (filters.scoreMin !== undefined) p['score_min'] = String(filters.scoreMin);
  if (filters.scoreMax !== undefined) p['score_max'] = String(filters.scoreMax);
  if (filters.hasExternalEdits !== undefined)
    p['has_external_edits'] = String(filters.hasExternalEdits);
  if (filters.hasLargePaste !== undefined) p['has_large_paste'] = String(filters.hasLargePaste);
  if (filters.recorderVersion) p['recorder_version'] = filters.recorderVersion;
  if (filters.includeSuperseded) p['include_superseded'] = 'true';
  if (filters.q) p['q'] = filters.q;
  if (cursor) p['cursor'] = cursor;
  return p;
}

function buildStudentParams(
  filters: CohortFilters,
  sort: StudentSort,
  cursor: string | null,
  limit: number,
): QueryParams {
  const p: QueryParams = { sort, limit: String(limit) };
  if (filters.assignmentId) p['assignment_id'] = filters.assignmentId;
  if (filters.flagIds?.length) p['flag_id'] = filters.flagIds;
  if (filters.severityMin) p['severity_min'] = filters.severityMin;
  if (filters.validationStatus) p['validation_status'] = filters.validationStatus;
  if (filters.scoreMin !== undefined) p['score_min'] = String(filters.scoreMin);
  if (filters.scoreMax !== undefined) p['score_max'] = String(filters.scoreMax);
  if (filters.hasExternalEdits !== undefined)
    p['has_external_edits'] = String(filters.hasExternalEdits);
  if (filters.hasLargePaste !== undefined) p['has_large_paste'] = String(filters.hasLargePaste);
  if (filters.recorderVersion) p['recorder_version'] = filters.recorderVersion;
  if (filters.includeSuperseded) p['include_superseded'] = 'true';
  if (filters.q) p['q'] = filters.q;
  if (cursor) p['cursor'] = cursor;
  return p;
}

/**
 * Builds a URL query string from a params map.
 * Multi-value arrays produce repeated keys (e.g. flag_id=a&flag_id=b).
 */
export function buildQueryString(params: QueryParams): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) {
        parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
      }
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
    }
  }
  return parts.join('&');
}
