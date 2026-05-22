/**
 * MSW request handlers for analyzer tests.
 *
 * These handlers mock the Provenance API endpoints at the network layer.
 * Tests that need different responses should use server.use() to override
 * specific handlers for the duration of that test.
 */

import { http, HttpResponse } from 'msw';

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
export function meWithMembershipsHandler(memberships: typeof defaultMeResponse.memberships) {
  return http.get('/api/v1/me', () => {
    return HttpResponse.json({
      ...defaultMeResponse,
      memberships,
    });
  });
}
