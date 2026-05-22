/**
 * React-Query hooks for Phase 20 endpoints.
 *
 * Endpoints consumed:
 * - GET /me  → useMe(), useSemesters() (semesters derive from /me memberships)
 * - POST /auth/logout → useLogout()
 *
 * Note: there is no /me/semesters endpoint. The server returns all memberships
 * inline in GET /me. useSemesters() re-uses the same /me query and maps the
 * memberships array to SemesterSummary objects.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch, UnauthorizedError } from './client.js';
import { MeResponseSchema } from '@provenance/shared/api-schemas';
import type { Membership } from '@provenance/shared/api-schemas';

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

export const queryKeys = {
  me: ['me'] as const,
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
