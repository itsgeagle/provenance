/**
 * authorize() and authorizeBlob() truth table tests.
 *
 * Pure functions — no DB, no async, no clock.
 */

import { describe, it, expect } from 'vitest';
import { authorize, authorizeBlob } from './authorize.js';
import type { Principal } from '../api/middleware/auth-session.js';
import type { MembershipRow } from './authorize.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeSessionPrincipal(overrides?: { is_superadmin?: boolean }): Principal {
  return {
    principal_kind: 'session',
    user: {
      id: 'user-uuid-1',
      google_subject: 'google-sub-1',
      email: 'user@berkeley.edu',
      display_name: 'Test User',
      is_superadmin: overrides?.is_superadmin ?? false,
      protected: false,
      created_at: new Date(),
      last_login_at: null,
    },
    session: {
      id: 'session-id',
      user_id: 'user-uuid-1',
      created_at: new Date(),
      last_seen_at: new Date(),
      expires_at: new Date(Date.now() + 86400_000),
      ip: null,
      user_agent: null,
      view_as_user_id: null,
      view_as_started_at: null,
    },
  };
}

function makeTokenPrincipal(overrides?: {
  is_superadmin?: boolean;
  read_only?: boolean;
  semester_ids?: string[] | null;
  include_blobs?: boolean;
}): Principal {
  return {
    principal_kind: 'token',
    user: {
      id: 'user-uuid-1',
      google_subject: 'google-sub-1',
      email: 'user@berkeley.edu',
      display_name: 'Test User',
      is_superadmin: overrides?.is_superadmin ?? false,
      protected: false,
      created_at: new Date(),
      last_login_at: null,
    },
    token: {
      id: 'token-uuid-1',
      user_id: 'user-uuid-1',
      label: 'Test Token',
      prefix: 'testprfx',
      hashed_token: 'hashed',
      scopes: {
        read_only: overrides?.read_only ?? false,
        semester_ids: overrides?.semester_ids !== undefined ? overrides.semester_ids : null,
        include_blobs: overrides?.include_blobs ?? false,
      },
      last_used_at: null,
      expires_at: null,
      revoked_at: null,
      created_at: new Date(),
    },
  };
}

const adminMembership: MembershipRow = { role: 'admin' };
const graderMembership: MembershipRow = { role: 'grader' };

const target = { semesterId: '00000000-0000-0000-0000-000000000001' };

// ---------------------------------------------------------------------------
// authorize() truth table
// ---------------------------------------------------------------------------

describe('authorize()', () => {
  it('null principal → DENY AUTH_REQUIRED', () => {
    const result = authorize(null, 'read', target, adminMembership);
    expect(result).toEqual({ ok: false, code: 'AUTH_REQUIRED' });
  });

  it('null principal → DENY AUTH_REQUIRED (no membership)', () => {
    const result = authorize(null, 'write', target, null);
    expect(result).toEqual({ ok: false, code: 'AUTH_REQUIRED' });
  });

  it('token read_only + write → DENY TOKEN_READ_ONLY', () => {
    const p = makeTokenPrincipal({ read_only: true });
    expect(authorize(p, 'write', target, adminMembership)).toEqual({
      ok: false,
      code: 'TOKEN_READ_ONLY',
    });
  });

  it('token read_only + admin → DENY TOKEN_READ_ONLY', () => {
    const p = makeTokenPrincipal({ read_only: true });
    expect(authorize(p, 'admin', target, adminMembership)).toEqual({
      ok: false,
      code: 'TOKEN_READ_ONLY',
    });
  });

  it('token read_only + read → passes through (no TOKEN_READ_ONLY)', () => {
    const p = makeTokenPrincipal({ read_only: true });
    // Still allowed if member
    const result = authorize(p, 'read', target, adminMembership);
    expect(result).toEqual({ ok: true });
  });

  it('token semester-scoped + out-of-band semester → DENY TOKEN_SCOPE_OUT_OF_BAND', () => {
    // semester_ids must be valid UUIDs per tokenScopesSchema
    const p = makeTokenPrincipal({ semester_ids: ['00000000-0000-0000-0000-000000000099'] });
    expect(authorize(p, 'read', target, adminMembership)).toEqual({
      ok: false,
      code: 'TOKEN_SCOPE_OUT_OF_BAND',
    });
  });

  it('token semester-scoped + in-scope semester → passes through', () => {
    const p = makeTokenPrincipal({ semester_ids: [target.semesterId] });
    expect(authorize(p, 'read', target, adminMembership)).toEqual({ ok: true });
  });

  it('token null semester_ids (no restriction) → passes through', () => {
    const p = makeTokenPrincipal({ semester_ids: null });
    expect(authorize(p, 'read', target, adminMembership)).toEqual({ ok: true });
  });

  it('superadmin session + write → ALLOW (no membership needed)', () => {
    const p = makeSessionPrincipal({ is_superadmin: true });
    expect(authorize(p, 'write', target, null)).toEqual({ ok: true });
  });

  it('superadmin session + admin → ALLOW', () => {
    const p = makeSessionPrincipal({ is_superadmin: true });
    expect(authorize(p, 'admin', target, null)).toEqual({ ok: true });
  });

  it('superadmin token + write → ALLOW', () => {
    const p = makeTokenPrincipal({ is_superadmin: true });
    expect(authorize(p, 'write', target, null)).toEqual({ ok: true });
  });

  it('admin role + admin action → ALLOW', () => {
    const p = makeSessionPrincipal();
    expect(authorize(p, 'admin', target, adminMembership)).toEqual({ ok: true });
  });

  it('grader role + admin action → DENY INSUFFICIENT_ROLE', () => {
    const p = makeSessionPrincipal();
    expect(authorize(p, 'admin', target, graderMembership)).toEqual({
      ok: false,
      code: 'INSUFFICIENT_ROLE',
    });
  });

  it('admin role + write action → ALLOW', () => {
    const p = makeSessionPrincipal();
    expect(authorize(p, 'write', target, adminMembership)).toEqual({ ok: true });
  });

  it('grader role + write action → DENY INSUFFICIENT_ROLE', () => {
    const p = makeSessionPrincipal();
    expect(authorize(p, 'write', target, graderMembership)).toEqual({
      ok: false,
      code: 'INSUFFICIENT_ROLE',
    });
  });

  it('admin role + read action → ALLOW', () => {
    const p = makeSessionPrincipal();
    expect(authorize(p, 'read', target, adminMembership)).toEqual({ ok: true });
  });

  it('grader role + read action → ALLOW', () => {
    const p = makeSessionPrincipal();
    expect(authorize(p, 'read', target, graderMembership)).toEqual({ ok: true });
  });

  it('non-member (null membership) → DENY NOT_A_MEMBER', () => {
    const p = makeSessionPrincipal();
    expect(authorize(p, 'read', target, null)).toEqual({
      ok: false,
      code: 'NOT_A_MEMBER',
    });
  });

  it('non-member + write → DENY NOT_A_MEMBER (checked before role)', () => {
    const p = makeSessionPrincipal();
    expect(authorize(p, 'write', target, null)).toEqual({
      ok: false,
      code: 'NOT_A_MEMBER',
    });
  });
});

// ---------------------------------------------------------------------------
// authorizeBlob() truth table
// ---------------------------------------------------------------------------

describe('authorizeBlob()', () => {
  it('null principal → DENY AUTH_REQUIRED', () => {
    expect(authorizeBlob(null, target, adminMembership)).toEqual({
      ok: false,
      code: 'AUTH_REQUIRED',
    });
  });

  it('token without include_blobs → DENY TOKEN_BLOB_NOT_PERMITTED', () => {
    const p = makeTokenPrincipal({ include_blobs: false });
    expect(authorizeBlob(p, target, adminMembership)).toEqual({
      ok: false,
      code: 'TOKEN_BLOB_NOT_PERMITTED',
    });
  });

  it('token with include_blobs + admin member → ALLOW', () => {
    const p = makeTokenPrincipal({ include_blobs: true });
    expect(authorizeBlob(p, target, adminMembership)).toEqual({ ok: true });
  });

  it('token with include_blobs + grader member → ALLOW (blob is a read action)', () => {
    const p = makeTokenPrincipal({ include_blobs: true });
    expect(authorizeBlob(p, target, graderMembership)).toEqual({ ok: true });
  });

  it('token with include_blobs + non-member → DENY NOT_A_MEMBER', () => {
    const p = makeTokenPrincipal({ include_blobs: true });
    expect(authorizeBlob(p, target, null)).toEqual({
      ok: false,
      code: 'NOT_A_MEMBER',
    });
  });

  it('session principal (no token) + admin member → ALLOW', () => {
    const p = makeSessionPrincipal();
    expect(authorizeBlob(p, target, adminMembership)).toEqual({ ok: true });
  });

  it('session principal + non-member → DENY NOT_A_MEMBER', () => {
    const p = makeSessionPrincipal();
    expect(authorizeBlob(p, target, null)).toEqual({
      ok: false,
      code: 'NOT_A_MEMBER',
    });
  });

  it('superadmin session (any) → ALLOW', () => {
    const p = makeSessionPrincipal({ is_superadmin: true });
    expect(authorizeBlob(p, target, null)).toEqual({ ok: true });
  });

  it('token read_only + include_blobs → ALLOW (blob is a read action)', () => {
    // read_only does not block read actions; blob check only checks include_blobs
    const p = makeTokenPrincipal({ read_only: true, include_blobs: true });
    expect(authorizeBlob(p, target, adminMembership)).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// View-as (V45)
// ---------------------------------------------------------------------------

describe('authorize() — view-as', () => {
  const target = { semesterId: 'semester-uuid-1' };
  const adminMembership: MembershipRow = { role: 'admin' };
  const graderMembership: MembershipRow = { role: 'grader' };

  function makeViewAsPrincipal(): Principal {
    const p = makeSessionPrincipal({ is_superadmin: true });
    // viewAs lives on the session-principal branch only.
    if (p.principal_kind !== 'session') throw new Error('unreachable');
    return {
      ...p,
      viewAs: {
        userId: 'target-user-uuid-2',
        startedAt: new Date(),
      },
    };
  }

  it('view-as superadmin + write action → DENY VIEW_AS_READ_ONLY', () => {
    const p = makeViewAsPrincipal();
    expect(authorize(p, 'write', target, adminMembership)).toEqual({
      ok: false,
      code: 'VIEW_AS_READ_ONLY',
    });
  });

  it('view-as superadmin + admin action → DENY VIEW_AS_READ_ONLY', () => {
    const p = makeViewAsPrincipal();
    expect(authorize(p, 'admin', target, adminMembership)).toEqual({
      ok: false,
      code: 'VIEW_AS_READ_ONLY',
    });
  });

  it('view-as superadmin + read with target NOT a member → DENY NOT_A_MEMBER (superadmin bypass skipped)', () => {
    const p = makeViewAsPrincipal();
    expect(authorize(p, 'read', target, null)).toEqual({
      ok: false,
      code: 'NOT_A_MEMBER',
    });
  });

  it('view-as superadmin + read with target a grader → ALLOW', () => {
    const p = makeViewAsPrincipal();
    expect(authorize(p, 'read', target, graderMembership)).toEqual({ ok: true });
  });

  it('view-as superadmin + read with target an admin → ALLOW', () => {
    const p = makeViewAsPrincipal();
    expect(authorize(p, 'read', target, adminMembership)).toEqual({ ok: true });
  });

  it('non-view-as superadmin still bypasses membership', () => {
    // Sanity: removing viewAs restores the standard superadmin bypass.
    const p = makeSessionPrincipal({ is_superadmin: true });
    expect(authorize(p, 'read', target, null)).toEqual({ ok: true });
    expect(authorize(p, 'write', target, null)).toEqual({ ok: true });
  });
});
