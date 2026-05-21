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
 */

import type { MiddlewareHandler } from 'hono';
import { requestLogger } from '../../logging.js';

// ---------------------------------------------------------------------------
// Hono context variable augmentation
// ---------------------------------------------------------------------------

declare module 'hono' {
  interface ContextVariableMap {
    requestId: string;
  }
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * Sets X-Request-Id on every response and binds a child logger.
 *
 * Echo rule: if the client sends X-Request-Id, use it verbatim (distributed
 * tracing). Otherwise generate a fresh UUID v4.
 */
export const requestId: MiddlewareHandler = async (c, next) => {
  const incoming = c.req.header('x-request-id');
  const id = incoming !== undefined && incoming.length > 0 ? incoming : crypto.randomUUID();

  c.set('requestId', id);

  // Bind a child logger; downstream can use c.var.logger instead of getLogger().
  // The root logger may not exist yet (config not parsed), so we lazily call
  // requestLogger which calls getLogger() internally.
  try {
    const logger = requestLogger(id);
    // Hono's ContextVariableMap is extensible; `logger` is declared elsewhere
    // if needed. We avoid re-declaring it here since logging.ts owns that type.
    // The variable is available as c.get('logger') once we set it below.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- logger is not in base ContextVariableMap yet; will be added when Phase 5 wires pino-http
    (c as any).set('logger', logger);
  } catch {
    // Config may not be ready in certain test paths; skip logger binding.
  }

  await next();

  // Set after next() so it appears on the response (Hono sets response headers
  // before returning the Response object from fetch()).
  c.res.headers.set('X-Request-Id', id);
};
