/**
 * Semesters CRUD routes integration tests.
 *
 * Tests all endpoints through the full v1 app pipeline.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { withTestDb } from '../../../../test/helpers/db.js';
import { _resetConfigForTest, _setConfigForTest } from '../../../config/index.js';
import { _resetLoggerForTest } from '../../../logging.js';
import { parseEnv } from '../../../config/env.js';
import { createV1App } from '../index.js';
import { users, sessions, courses, semesters, memberships } from '../../../db/schema.js';
import type { DrizzleDb } from '../../../db/client.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// ---------------------------------------------------------------------------
// Test env
// ---------------------------------------------------------------------------

const BASE_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  PUBLIC_BASE_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgres://user:pass@localhost:5432/provenance',
  OBJECT_STORAGE_ENDPOINT: 'http://localhost:9000',
  OBJECT_STORAGE_BUCKET: 'provenance',
  OBJECT_STORAGE_ACCESS_KEY_ID: 'minioadmin',
  OBJECT_STORAGE_SECRET_ACCESS_KEY: 'minioadmin',
  GOOGLE_OAUTH_CLIENT_ID: 'client-id',
  GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
  AUTH_ALLOWED_HOSTED_DOMAINS: '["berkeley.edu"]',
  AUTH_SUPERADMIN_EMAILS: '["admin@berkeley.edu"]',
  AUTH_COOKIE_SIGNING_SECRET: 'test-signing-secret-for-semesters-tests-12345678901',
  SESSION_TTL_DAYS: '14',
};

beforeEach(() => {
  _resetConfigForTest();
  _resetLoggerForTest();
  _setConfigForTest(parseEnv(BASE_ENV));
});

// ---------------------------------------------------------------------------
// DB injection
// ---------------------------------------------------------------------------

let _testDb: DrizzleDb | null = null;

vi.mock('../../../db/client.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../db/client.js')>();
  return {
    ...original,
    getDb: () => {
      if (_testDb !== null) return _testDb;
      return original.getDb();
    },
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function insertUser(
  db: DrizzleDb,
  overrides?: Partial<typeof users.$inferInsert>,
) {
  const randomId = Math.random().toString(36).slice(2);
  const rows = await db
    .insert(users)
    .values({
      google_subject: `sub-${randomId}`,
      email: `test-${randomId}@berkeley.edu`,
      display_name: 'Test User',
      is_superadmin: false,
      ...overrides,
    })
    .returning();
  return rows[0]!;
}

async function insertSession(
  db: DrizzleDb,
  userId: string,
  expiresAt: Date = new Date(Date.now() + 14 * 86400_000),
): Promise<string> {
  const id = 'a'.repeat(43);
  const uniqueId = `${id.slice(0, 10)}${Math.random().toString(36).slice(2)}`
    .padEnd(43, 'x')
    .slice(0, 43);
  await db.insert(sessions).values({
    id: uniqueId,
    user_id: userId,
    expires_at: expiresAt,
  });
  return uniqueId;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/v1/courses/:courseId/semesters', () => {
  it('creates a semester as superadmin', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db, { is_superadmin: true });
        const sessionId = await insertSession(db, admin.id);

        const [course] = await db
          .insert(courses)
          .values({ name: 'CS 61A', slug: 'cs61a' })
          .returning();

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/courses/${course!.id}/semesters`, {
            method: 'POST',
            headers: { Cookie: `__Host-prov_sess=${sessionId}`, 'content-type': 'application/json' },
            body: JSON.stringify({
              term: 'fa',
              year: 2024,
              slug: 'fa2024',
              display_name: 'Fall 2024',
              filename_convention: '(?<sid>[a-z0-9]+)_hw',
            }),
          }),
        );

        expect(res.status).toBe(201);
        const body = await res.json();
        expect(body.semester.slug).toBe('fa2024');
        expect(body.semester.term).toBe('fa');
      } finally {
        _testDb = null;
      }
    });
  });

  it('rejects non-superadmin', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const user = await insertUser(db, { is_superadmin: false });
        const sessionId = await insertSession(db, user.id);

        const [course] = await db
          .insert(courses)
          .values({ name: 'CS 61A', slug: 'cs61a' })
          .returning();

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/courses/${course!.id}/semesters`, {
            method: 'POST',
            headers: { Cookie: `__Host-prov_sess=${sessionId}`, 'content-type': 'application/json' },
            body: JSON.stringify({
              term: 'fa',
              year: 2024,
              slug: 'fa2024',
              display_name: 'Fall 2024',
              filename_convention: '(?<sid>[a-z0-9]+)_hw',
            }),
          }),
        );

        expect(res.status).toBe(403);
      } finally {
        _testDb = null;
      }
    });
  });

  it('rejects invalid filename_convention', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db, { is_superadmin: true });
        const sessionId = await insertSession(db, admin.id);

        const [course] = await db
          .insert(courses)
          .values({ name: 'CS 61A', slug: 'cs61a' })
          .returning();

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/courses/${course!.id}/semesters`, {
            method: 'POST',
            headers: { Cookie: `__Host-prov_sess=${sessionId}`, 'content-type': 'application/json' },
            body: JSON.stringify({
              term: 'fa',
              year: 2024,
              slug: 'fa2024',
              display_name: 'Fall 2024',
              filename_convention: '(?<other>[a-z0-9]+)_hw', // missing (?<sid>...)
            }),
          }),
        );

        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error.code).toBe('VALIDATION_REGEX');
      } finally {
        _testDb = null;
      }
    });
  });
});

describe('GET /api/v1/courses/:courseId/semesters', () => {
  it('lists semesters in a course', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const user = await insertUser(db, { is_superadmin: true });
        const sessionId = await insertSession(db, user.id);

        const [course] = await db
          .insert(courses)
          .values({ name: 'CS 61A', slug: 'cs61a' })
          .returning();

        await db
          .insert(semesters)
          .values({
            course_id: course!.id,
            term: 'fa',
            year: 2024,
            slug: 'fa2024',
            display_name: 'Fall 2024',
            filename_convention: '(?<sid>[a-z0-9]+)_hw',
          });

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/courses/${course!.id}/semesters`, {
            headers: { Cookie: `__Host-prov_sess=${sessionId}` },
          }),
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(Array.isArray(body.semesters)).toBe(true);
        expect(body.semesters.length).toBe(1);
        expect(body.semesters[0].slug).toBe('fa2024');
      } finally {
        _testDb = null;
      }
    });
  });
});

describe('GET /api/v1/semesters/:semesterId', () => {
  it('gets semester detail for member', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db, { is_superadmin: true });
        const user = await insertUser(db, { is_superadmin: false });
        const sessionId = await insertSession(db, user.id);

        const [course] = await db
          .insert(courses)
          .values({ name: 'CS 61A', slug: 'cs61a' })
          .returning();

        const [semester] = await db
          .insert(semesters)
          .values({
            course_id: course!.id,
            term: 'fa',
            year: 2024,
            slug: 'fa2024',
            display_name: 'Fall 2024',
            filename_convention: '(?<sid>[a-z0-9]+)_hw',
          })
          .returning();

        // Add user as member
        await db.insert(memberships).values({
          user_id: user.id,
          semester_id: semester!.id,
          role: 'grader',
          granted_by: admin.id,
        });

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester!.id}`, {
            headers: { Cookie: `__Host-prov_sess=${sessionId}` },
          }),
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.semester.id).toBe(semester!.id);
        expect(body.semester.my_role).toBe('grader');
      } finally {
        _testDb = null;
      }
    });
  });

  it('rejects non-member', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const user = await insertUser(db, { is_superadmin: false });
        const sessionId = await insertSession(db, user.id);

        const [course] = await db
          .insert(courses)
          .values({ name: 'CS 61A', slug: 'cs61a' })
          .returning();

        const [semester] = await db
          .insert(semesters)
          .values({
            course_id: course!.id,
            term: 'fa',
            year: 2024,
            slug: 'fa2024',
            display_name: 'Fall 2024',
            filename_convention: '(?<sid>[a-z0-9]+)_hw',
          })
          .returning();

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester!.id}`, {
            headers: { Cookie: `__Host-prov_sess=${sessionId}` },
          }),
        );

        expect(res.status).toBe(403);
      } finally {
        _testDb = null;
      }
    });
  });
});

describe('PATCH /api/v1/semesters/:semesterId', () => {
  it('updates semester as admin', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db, { is_superadmin: false });
        const sessionId = await insertSession(db, admin.id);

        const [course] = await db
          .insert(courses)
          .values({ name: 'CS 61A', slug: 'cs61a' })
          .returning();

        const [semester] = await db
          .insert(semesters)
          .values({
            course_id: course!.id,
            term: 'fa',
            year: 2024,
            slug: 'fa2024',
            display_name: 'Fall 2024',
            filename_convention: '(?<sid>[a-z0-9]+)_hw',
          })
          .returning();

        // Add user as admin
        const adminUser = await insertUser(db, { is_superadmin: true });
        await db.insert(memberships).values({
          user_id: admin.id,
          semester_id: semester!.id,
          role: 'admin',
          granted_by: adminUser.id,
        });

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester!.id}`, {
            method: 'PATCH',
            headers: { Cookie: `__Host-prov_sess=${sessionId}`, 'content-type': 'application/json' },
            body: JSON.stringify({ display_name: 'Fall 2024 (Updated)' }),
          }),
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.semester.display_name).toBe('Fall 2024 (Updated)');
      } finally {
        _testDb = null;
      }
    });
  });
});

describe('POST /api/v1/semesters/:semesterId/archive', () => {
  it('archives a semester as superadmin', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db, { is_superadmin: true });
        const sessionId = await insertSession(db, admin.id);

        const [course] = await db
          .insert(courses)
          .values({ name: 'CS 61A', slug: 'cs61a' })
          .returning();

        const [semester] = await db
          .insert(semesters)
          .values({
            course_id: course!.id,
            term: 'fa',
            year: 2024,
            slug: 'fa2024',
            display_name: 'Fall 2024',
            filename_convention: '(?<sid>[a-z0-9]+)_hw',
          })
          .returning();

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester!.id}/archive`, {
            method: 'POST',
            headers: { Cookie: `__Host-prov_sess=${sessionId}` },
          }),
        );

        expect(res.status).toBe(204);
      } finally {
        _testDb = null;
      }
    });
  });
});
