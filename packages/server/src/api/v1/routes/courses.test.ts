/**
 * Courses CRUD routes integration tests.
 *
 * Tests all endpoints through the full v1 app pipeline (auth + rate + audit).
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { withTestDb } from '../../../../test/helpers/db.js';
import { _resetConfigForTest, _setConfigForTest } from '../../../config/index.js';
import { _resetLoggerForTest } from '../../../logging.js';
import { parseEnv } from '../../../config/env.js';
import { createV1App } from '../index.js';
import { users, sessions, courses } from '../../../db/schema.js';
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
  AUTH_COOKIE_SIGNING_SECRET: 'test-signing-secret-for-courses-tests-1234567890ab',
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

describe('POST /api/v1/courses', () => {
  it('creates a course as superadmin', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db, { is_superadmin: true });
        const sessionId = await insertSession(db, admin.id);

        const app = createV1App();
        const res = await app.fetch(
          new Request('http://localhost/api/v1/courses', {
            method: 'POST',
            headers: { Cookie: `__Host-prov_sess=${sessionId}`, 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'CS 61A', slug: 'cs61a' }),
          }),
        );

        expect(res.status).toBe(201);
        const body = await res.json();
        expect(body.course.name).toBe('CS 61A');
        expect(body.course.slug).toBe('cs61a');
        expect(body.course.archived).toBe(false);
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

        const app = createV1App();
        const res = await app.fetch(
          new Request('http://localhost/api/v1/courses', {
            method: 'POST',
            headers: { Cookie: `__Host-prov_sess=${sessionId}`, 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'CS 61A', slug: 'cs61a' }),
          }),
        );

        expect(res.status).toBe(403);
        const body = await res.json();
        expect(body.error.code).toBe('INSUFFICIENT_ROLE');
      } finally {
        _testDb = null;
      }
    });
  });

  it('rejects unauthenticated request', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const app = createV1App();
        const res = await app.fetch(
          new Request('http://localhost/api/v1/courses', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'CS 61A', slug: 'cs61a' }),
          }),
        );

        expect(res.status).toBe(401);
      } finally {
        _testDb = null;
      }
    });
  });

  it('rejects duplicate slug', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db, { is_superadmin: true });
        const sessionId = await insertSession(db, admin.id);

        // Create first course
        await db
          .insert(courses)
          .values({ name: 'CS 61A', slug: 'cs61a' });

        // Try to create duplicate
        const app = createV1App();
        const res = await app.fetch(
          new Request('http://localhost/api/v1/courses', {
            method: 'POST',
            headers: { Cookie: `__Host-prov_sess=${sessionId}`, 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'Another', slug: 'cs61a' }),
          }),
        );

        expect(res.status).toBe(409);
        const body = await res.json();
        expect(body.error.code).toBe('COURSE_SLUG_TAKEN');
      } finally {
        _testDb = null;
      }
    });
  });
});

describe('GET /api/v1/courses', () => {
  it('lists courses for authenticated user', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const user = await insertUser(db, { is_superadmin: false });
        const sessionId = await insertSession(db, user.id);

        // Insert a course
        await db
          .insert(courses)
          .values({ name: 'CS 61A', slug: 'cs61a' });

        const app = createV1App();
        const res = await app.fetch(
          new Request('http://localhost/api/v1/courses', {
            headers: { Cookie: `__Host-prov_sess=${sessionId}` },
          }),
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(Array.isArray(body.courses)).toBe(true);
      } finally {
        _testDb = null;
      }
    });
  });

  it('rejects unauthenticated request', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const app = createV1App();
        const res = await app.fetch(
          new Request('http://localhost/api/v1/courses'),
        );

        expect(res.status).toBe(401);
      } finally {
        _testDb = null;
      }
    });
  });
});

describe('GET /api/v1/courses/:id', () => {
  it('gets a course', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const user = await insertUser(db, { is_superadmin: true });
        const sessionId = await insertSession(db, user.id);

        const [course] = await db
          .insert(courses)
          .values({ name: 'CS 61A', slug: 'cs61a' })
          .returning();

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/api/v1/courses/${course!.id}`, {
            headers: { Cookie: `__Host-prov_sess=${sessionId}` },
          }),
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.course.id).toBe(course!.id);
        expect(body.course.slug).toBe('cs61a');
      } finally {
        _testDb = null;
      }
    });
  });

  it('returns 404 for nonexistent course', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const user = await insertUser(db, { is_superadmin: true });
        const sessionId = await insertSession(db, user.id);

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/api/v1/courses/00000000-0000-0000-0000-000000000000`, {
            headers: { Cookie: `__Host-prov_sess=${sessionId}` },
          }),
        );

        expect(res.status).toBe(404);
      } finally {
        _testDb = null;
      }
    });
  });
});

describe('PATCH /api/v1/courses/:id', () => {
  it('updates course name as superadmin', async () => {
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
          new Request(`http://localhost/api/v1/courses/${course!.id}`, {
            method: 'PATCH',
            headers: { Cookie: `__Host-prov_sess=${sessionId}`, 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'Computer Science 61A' }),
          }),
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.course.name).toBe('Computer Science 61A');
      } finally {
        _testDb = null;
      }
    });
  });
});

describe('POST /api/v1/courses/:id/archive', () => {
  it('archives a course as superadmin', async () => {
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
          new Request(`http://localhost/api/v1/courses/${course!.id}/archive`, {
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
