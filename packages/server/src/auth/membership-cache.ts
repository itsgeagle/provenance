/**
 * Request-scoped membership cache.
 *
 * Wraps DB lookups for `memberships` with a per-request Map keyed by
 * `(userId, semesterId)`. The cache is stored on `c.var.membershipCache`
 * (set by the `initMembershipCache` middleware) so it is strictly
 * request-scoped — no cross-request leakage is possible.
 *
 * Why not a WeakMap on the Context object? Hono Context objects are
 * not guaranteed to be stable across middleware for cache keying; a
 * per-request Map set on `c.var` is clearer and equally isolated.
 *
 * Context variables are declared in api/hono-context.d.ts.
 */

import type { MiddlewareHandler } from 'hono';
import { eq, and } from 'drizzle-orm';
import { memberships } from '../db/schema.js';
import type { DrizzleDb } from '../db/client.js';

// ---------------------------------------------------------------------------
// Cache type
// ---------------------------------------------------------------------------

/** A resolved membership for a (user, semester) pair. */
export interface CachedMembership {
  role: 'admin' | 'grader';
}

/** Per-request cache: `"userId:semesterId"` → CachedMembership | null */
export type MembershipCache = Map<string, CachedMembership | null>;

// ---------------------------------------------------------------------------
// Cache key
// ---------------------------------------------------------------------------

function cacheKey(userId: string, semesterId: string): string {
  return `${userId}:${semesterId}`;
}

// ---------------------------------------------------------------------------
// initMembershipCache middleware
// ---------------------------------------------------------------------------

/**
 * Middleware that initializes a fresh, empty MembershipCache on `c.var`.
 *
 * Mount this once at the v1 app level, before any route that uses
 * `findMembership`. Each request gets its own Map instance.
 */
export const initMembershipCache: MiddlewareHandler = async (c, next) => {
  c.set('membershipCache', new Map<string, CachedMembership | null>());
  await next();
};

// ---------------------------------------------------------------------------
// findMembership
// ---------------------------------------------------------------------------

/**
 * Returns the membership for `(userId, semesterId)`, or null if the user is
 * not a member of that semester.
 *
 * Results are cached for the lifetime of the request in `c.var.membershipCache`
 * so repeated calls within the same request don't hit the DB more than once.
 *
 * @param cache      The per-request cache from `c.var.membershipCache`.
 * @param db         The Drizzle DB instance for the request.
 * @param userId     The user's UUID.
 * @param semesterId The semester's UUID.
 */
export async function findMembership(
  cache: MembershipCache,
  db: DrizzleDb,
  userId: string,
  semesterId: string,
): Promise<CachedMembership | null> {
  const key = cacheKey(userId, semesterId);

  // Positive cache hit
  if (cache.has(key)) {
    return cache.get(key) ?? null;
  }

  // DB lookup
  const rows = await db
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.user_id, userId), eq(memberships.semester_id, semesterId)))
    .limit(1);

  const row = rows[0];
  const result: CachedMembership | null =
    row !== undefined && (row.role === 'admin' || row.role === 'grader')
      ? { role: row.role }
      : null;

  cache.set(key, result);
  return result;
}
