/**
 * API client for the Provenance server.
 *
 * Provides a single `apiFetch` wrapper that:
 * - Resolves paths against VITE_API_BASE_URL (default: /api/v1)
 * - Sends cookies (credentials: 'include') for session auth
 * - Sets Accept: application/json
 * - Parses error responses as { error: { code, message, details? } }
 * - Throws UnauthorizedError on 401 so React-Query can redirect to /login
 * - Throws ApiError for non-2xx responses
 * - Optionally parses the response body with a Zod schema
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class UnauthorizedError extends ApiError {
  constructor(message = 'Authentication required', details?: unknown) {
    super(401, 'AUTH_REQUIRED', message, details);
    this.name = 'UnauthorizedError';
  }
}

// ---------------------------------------------------------------------------
// Response shape helpers
// ---------------------------------------------------------------------------

const ErrorBodySchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

// ---------------------------------------------------------------------------
// Base URL
// ---------------------------------------------------------------------------

function getBaseUrl(): string {
  // VITE_API_BASE_URL is set at build time or via .env.local.
  // Default to /api/v1 for same-origin dev proxy (Vite proxies /api to the server).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Vite injects import.meta.env at build time; type is `any` via Vite's glob typing
  const env = (typeof import.meta !== 'undefined' ? (import.meta as any).env : {}) as Record<
    string,
    string | undefined
  >;
  return env['VITE_API_BASE_URL'] ?? '/api/v1';
}

// ---------------------------------------------------------------------------
// apiFetch
// ---------------------------------------------------------------------------

/**
 * Fetch wrapper for the Provenance API.
 *
 * @param path   Path relative to the API base (e.g. '/me', '/me/semesters').
 *               Should start with '/'.
 * @param init   Standard RequestInit options (method, body, headers, etc.).
 * @param schema Optional Zod schema to validate the response body against.
 *               If omitted, the raw parsed JSON is returned.
 */
export async function apiFetch<T>(
  path: string,
  init?: RequestInit,
  schema?: z.ZodType<T>,
): Promise<T> {
  const url = `${getBaseUrl()}${path}`;

  const response = await fetch(url, {
    ...init,
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      ...(init?.headers ?? {}),
    },
  });

  // 204 No Content — no body to parse
  if (response.status === 204) {
    return undefined as T;
  }

  // Attempt to parse as JSON
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // Non-JSON body (e.g. 5xx HTML error page)
    if (!response.ok) {
      throw new ApiError(response.status, 'SERVER_ERROR', `HTTP ${response.status}`);
    }
    return undefined as T;
  }

  if (!response.ok) {
    // Try to extract structured error
    const parsed = ErrorBodySchema.safeParse(body);
    if (parsed.success) {
      const { code, message, details } = parsed.data.error;
      if (response.status === 401) {
        throw new UnauthorizedError(message, details);
      }
      throw new ApiError(response.status, code, message, details);
    }
    // Unstructured error
    if (response.status === 401) {
      throw new UnauthorizedError();
    }
    throw new ApiError(response.status, 'SERVER_ERROR', `HTTP ${response.status}`);
  }

  // Parse with schema if provided
  if (schema !== undefined) {
    const result = schema.safeParse(body);
    if (!result.success) {
      throw new ApiError(
        500,
        'RESPONSE_PARSE_ERROR',
        `Response validation failed: ${result.error.message}`,
      );
    }
    return result.data;
  }

  return body as T;
}
