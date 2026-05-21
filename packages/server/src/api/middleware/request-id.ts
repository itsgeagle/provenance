/**
 * Request ID middleware (PRD §7.7).
 *
 * Generates a UUID v4 for each request, sets it on `c.var.requestId`,
 * and emits it as `X-Request-Id` on the response.
 *
 * If the client already sent `X-Request-Id`, that value is echoed through
 * (useful for distributed tracing correlation).
 *
 * Also binds a child pino logger to `c.var.logger` so all downstream code
 * can use a logger that automatically includes `request_id` in every line.
 *
 * Context variables are declared in ../hono-context.d.ts.
 */

import type { MiddlewareHandler } from 'hono';
import { requestLogger } from '../../logging.js';

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Request ID validation
// ---------------------------------------------------------------------------

/**
 * Allowlist for echoed X-Request-Id values.
 *
 * Only printable ASCII characters (0x20–0x7E), max 128 characters.
 * This prevents header injection (\r\n sequences would allow header splitting
 * in the echoed X-Request-Id response header) and log injection.
 *
 * If the client sends a value that fails validation, a fresh UUID is generated
 * silently — the middleware should be transparent and never fail a request.
 */
const SAFE_REQUEST_ID = /^[\x20-\x7E]{1,128}$/;

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * Sets X-Request-Id on every response and binds a child logger.
 *
 * Echo rule: if the client sends X-Request-Id AND it passes the safe-ASCII
 * validation (max 128 printable chars), echo it through for distributed tracing.
 * Otherwise generate a fresh UUID v4. This prevents header/log injection.
 */
export const requestId: MiddlewareHandler = async (c, next) => {
  const incoming = c.req.header('x-request-id');
  const id =
    incoming !== undefined && SAFE_REQUEST_ID.test(incoming) ? incoming : crypto.randomUUID();

  c.set('requestId', id);

  // Bind a child logger; downstream can use c.var.logger instead of getLogger().
  // The root logger may not exist yet (config not parsed), so we lazily call
  // requestLogger which calls getLogger() internally.
  try {
    const logger = requestLogger(id);
    c.set('logger', logger);
  } catch {
    // Config may not be ready in certain test paths; skip logger binding.
  }

  await next();

  // Set after next() so it appears on the response (Hono sets response headers
  // before returning the Response object from fetch()).
  c.res.headers.set('X-Request-Id', id);
};
