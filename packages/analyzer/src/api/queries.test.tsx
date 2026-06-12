/**
 * Regression tests for the member-mutation cache invalidation.
 *
 * The home-page tiles and the `/s/:slug` slug→id resolution both derive from
 * the `/me` query (and its `['me','semesters']` slice). When you add yourself
 * to a semester's staff, that query MUST be invalidated — otherwise a freshly
 * added membership stays invisible until the 5-minute staleTime expires or the
 * user hard-refreshes, which is exactly the "I added myself but no tile shows"
 * bug. These tests pin that invalidation.
 */

import type { ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { mswServer } from '../test-setup.js';
import { useInviteMember, useAddSelfAsAdmin } from './queries.js';

const SEMESTER_ID = '00000000-0000-0000-0000-000000000010';
const COURSE_ID = 'cc000000-0000-0000-0000-000000000001';

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0 } },
  });
}

function wrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

describe('useInviteMember', () => {
  it('invalidates /me (home tiles + slug resolution) on success, not just the members list', async () => {
    mswServer.use(
      http.post(`/api/v1/semesters/${SEMESTER_ID}/members`, () =>
        HttpResponse.json({ kind: 'member' }),
      ),
    );

    const qc = makeQueryClient();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useInviteMember(SEMESTER_ID), { wrapper: wrapper(qc) });

    result.current.mutate({ email: 'me@berkeley.edu', role: 'admin' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['members', SEMESTER_ID] });
    // ['me'] prefix-matches both the useMe query and the ['me','semesters'] slice.
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['me'] });
  });
});

describe('useAddSelfAsAdmin', () => {
  it('POSTs role=admin for the given semester and invalidates members, admin list, and /me', async () => {
    let postedBody: unknown;
    mswServer.use(
      http.post(`/api/v1/semesters/${SEMESTER_ID}/members`, async ({ request }) => {
        postedBody = await request.json();
        return HttpResponse.json({ kind: 'member' });
      }),
    );

    const qc = makeQueryClient();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useAddSelfAsAdmin(COURSE_ID), { wrapper: wrapper(qc) });

    result.current.mutate({ semesterId: SEMESTER_ID, email: 'me@berkeley.edu' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(postedBody).toEqual({ email: 'me@berkeley.edu', role: 'admin' });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['members', SEMESTER_ID] });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['admin', 'courses', COURSE_ID, 'semesters'],
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['me'] });
  });
});
