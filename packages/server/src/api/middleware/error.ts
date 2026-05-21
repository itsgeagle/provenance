/**
 * Global error handler middleware (PRD §7.3).
 *
 * Maps thrown errors to the §7.3 error response shape:
 *   { "error": { "code": string, "message": string, "details"?: object } }
 *
 * Three cases:
 *   1. ApiError — serialize to its code/status/details directly.
 *   2. ZodError — convert to VALIDATION (400) with details.issues.
 *   3. Everything else — log at error level, return 500 INTERNAL.
 *      Stack trace is included in `details.stack` in development mode only.
 *
 * Wire via: `app.onError(errorFormatter)` in api/start.ts.
 */

import type { ErrorHandler } from 'hono';
import { ZodError } from 'zod';
import { ApiError, Errors } from '../v1/errors.js';
import { getConfig } from '../../config/index.js';
import { getLogger } from '../../logging.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Hono's ErrorHandler typing requires `any` for the Env generic parameter
export const errorFormatter: ErrorHandler<any> = (err, c) => {
  // -------------------------------------------------------------------------
  // Case 1: ApiError — serialize directly
  // -------------------------------------------------------------------------
  if (err instanceof ApiError) {
    return c.json(err.toBody(), err.status as Parameters<typeof c.json>[1]);
  }

  // -------------------------------------------------------------------------
  // Case 2: ZodError — convert to VALIDATION
  // -------------------------------------------------------------------------
  if (err instanceof ZodError) {
    const apiError = Errors.validation(err.issues);
    return c.json(apiError.toBody(), 400);
  }

  // -------------------------------------------------------------------------
  // Case 3: Unexpected error — log, return 500
  // -------------------------------------------------------------------------

  const requestId = c.var.requestId;

  try {
    getLogger().error(
      {
        err,
        request_id: requestId,
      },
      'Unhandled error in request pipeline',
    );
  } catch {
    // Logger initialization may fail during tests or early startup.
    // Fall through silently — the 500 response is still returned.
  }

  // Include stack only in non-production environments.
  let isProduction = true; // default to production-safe behavior
  try {
    isProduction = getConfig().NODE_ENV === 'production';
  } catch {
    // Config not yet available — treat as production (safe default).
  }

  const stack = !isProduction && err instanceof Error ? err.stack : undefined;
  const apiError = Errors.internal(requestId, stack);
  return c.json(apiError.toBody(), 500);
};
