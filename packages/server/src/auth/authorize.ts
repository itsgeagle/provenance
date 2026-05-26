/**
 * Authorization decision function (PRD §4.5).
 *
 * Pure: takes principal + action + target + pre-fetched membership.
 * No DB calls. No async. The caller is responsible for fetching the membership.
 *
 * Separate `authorizeBlob` for the bundle download endpoint,
 * which requires `include_blobs` scope on token principals.
 */

import type { Principal } from '../api/middleware/auth-session.js';
import type { ApiErrorCode } from '../api/v1/errors.js';
import { tokenScopesSchema } from './tokens.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Action = 'read' | 'write' | 'admin';

export type Target = { semesterId: string };

export type MembershipRow = { role: 'admin' | 'grader' };

export type AuthorizeResult = { ok: true } | { ok: false; code: ApiErrorCode };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parses the `scopes` field from an ApiToken, which may be stored as a string
 * (depending on the postgres driver's jsonb handling) or as an object.
 */
function parseScopes(raw: unknown): ReturnType<typeof tokenScopesSchema.parse> {
  const value = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
  return tokenScopesSchema.parse(value);
}

// ---------------------------------------------------------------------------
// authorize()
// ---------------------------------------------------------------------------

/**
 * The central authorization decision function (PRD §4.5).
 *
 * Steps:
 *  1. null principal → DENY AUTH_REQUIRED
 *  2. Session with view-as + non-read action → DENY VIEW_AS_READ_ONLY
 *  3. Token read-only + non-read action → DENY TOKEN_READ_ONLY
 *  4. Token semester-scoped + target not in scope → DENY TOKEN_SCOPE_OUT_OF_BAND
 *  5. Superadmin (and NOT in view-as) → ALLOW (bypasses membership check)
 *  6. No membership → DENY NOT_A_MEMBER
 *  7. admin action + grader role → DENY INSUFFICIENT_ROLE
 *  8. write action + grader role → DENY INSUFFICIENT_ROLE
 *  9. ALLOW
 *
 * View-as note (V45): when the caller is a superadmin in view-as mode, the
 * membership argument MUST be the target user's membership for `target`, not
 * the superadmin's. requireAuth handles this lookup-swap upstream. authorize()
 * itself only sees the (already-resolved) membership row.
 *
 * @param principal   Resolved principal or null for anonymous.
 * @param action      Requested action: 'read' | 'write' | 'admin'.
 * @param target      The semester being accessed.
 * @param membership  Caller-fetched membership row, or null if not a member.
 */
export function authorize(
  principal: Principal | null,
  action: Action,
  target: Target,
  membership: MembershipRow | null,
): AuthorizeResult {
  // Step 1: require authentication
  if (principal === null) {
    return { ok: false, code: 'AUTH_REQUIRED' };
  }

  // Step 2: view-as is strictly read-only. The superadmin keeps their actual
  // identity for audit, but cannot perform any writes while impersonating.
  const viewAs = principal.principal_kind === 'session' ? principal.viewAs : undefined;
  if (viewAs !== undefined && action !== 'read') {
    return { ok: false, code: 'VIEW_AS_READ_ONLY' };
  }

  // Steps 3–4: token-specific scope checks
  if (principal.principal_kind === 'token') {
    const scopes = parseScopes(principal.token.scopes);

    // Step 3: read-only token attempting a non-read action
    if (scopes.read_only && action !== 'read') {
      return { ok: false, code: 'TOKEN_READ_ONLY' };
    }

    // Step 4: token restricted to specific semesters
    if (scopes.semester_ids !== null && !scopes.semester_ids.includes(target.semesterId)) {
      return { ok: false, code: 'TOKEN_SCOPE_OUT_OF_BAND' };
    }
  }

  // Step 5: superadmin bypasses all membership checks — UNLESS they're in
  // view-as mode, where the whole point is to see exactly what the target
  // user would see (i.e. honor the target's memberships strictly).
  if (principal.user.is_superadmin && viewAs === undefined) {
    return { ok: true };
  }

  // Step 6: must be a member
  if (membership === null) {
    return { ok: false, code: 'NOT_A_MEMBER' };
  }

  // Steps 7–8: role checks for elevated actions
  if (action === 'admin' && membership.role !== 'admin') {
    return { ok: false, code: 'INSUFFICIENT_ROLE' };
  }
  if (action === 'write' && membership.role !== 'admin') {
    return { ok: false, code: 'INSUFFICIENT_ROLE' };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// authorizeBlob()
// ---------------------------------------------------------------------------

/**
 * Authorization check for the bundle download endpoint (PRD §4.5 last paragraph).
 *
 * Requires `action='read'` AND (for token principals) `scopes.include_blobs === true`.
 * Falls through to the standard `authorize()` logic after token checks pass.
 *
 * @param principal   Resolved principal or null for anonymous.
 * @param target      The semester being accessed.
 * @param membership  Caller-fetched membership row, or null if not a member.
 */
export function authorizeBlob(
  principal: Principal | null,
  target: Target,
  membership: MembershipRow | null,
): AuthorizeResult {
  if (principal === null) {
    return { ok: false, code: 'AUTH_REQUIRED' };
  }

  // Token-specific: must have include_blobs scope
  if (principal.principal_kind === 'token') {
    const scopes = parseScopes(principal.token.scopes);
    if (!scopes.include_blobs) {
      return { ok: false, code: 'TOKEN_BLOB_NOT_PERMITTED' };
    }
  }

  // All other checks are the same as read access
  return authorize(principal, 'read', target, membership);
}
