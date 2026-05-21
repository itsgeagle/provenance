/**
 * Hono context variable augmentation.
 *
 * Declares all context variables (c.var.*) used across the server.
 * This allows TypeScript to infer types for context.set() and context.get() calls
 * without needing unsafe `as any` casts.
 */

import type { Logger } from 'pino';
import type { Principal } from './middleware/auth-session.js';
import type { Target } from '../auth/authorize.js';
import type { CachedMembership } from '../auth/membership-cache.js';
import type { GoogleOAuthClient } from '../auth/google.js';

declare module 'hono' {
  interface ContextVariableMap {
    /** Request ID (UUID v4 or echoed from client). Set by requestId middleware. */
    requestId: string;

    /** Pino logger with request_id bound. Set by requestId middleware. */
    logger: Logger;

    /** Resolved principal (session or token) or null. Set by authSessionMiddleware. */
    principal: Principal | null;

    /** Per-request membership cache. Set by initMembershipCache middleware. */
    membershipCache: Map<string, CachedMembership | null>;

    /** Authorization target (semester context). Set by requireAuth middleware. Null for global routes. */
    target: Target | null;

    /** Optional arbitrary detail object that routes populate before responding. Consumed by audit middleware. */
    auditDetail: Record<string, unknown>;

    /** GoogleOAuthClient injected per-request. Set by auth router. Production uses real client; tests inject fake. */
    googleOAuthClient: GoogleOAuthClient;
  }
}
