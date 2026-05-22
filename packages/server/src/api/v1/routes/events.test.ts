/**
 * Events endpoints integration tests (Phase 17).
 *
 * Tests through createV1App() per V18 rule.
 *
 * Test groups:
 *   1. GET /submissions/:id/events           — list with filters and pagination
 *   2. GET /submissions/:id/events/:seq      — single event by seq
 *   3. Events query builder unit tests       — SQL builder assertions
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { withTestDb } from '../../../../test/helpers/db.js';
import { _resetConfigForTest, _setConfigForTest } from '../../../config/index.js';
import { _resetLoggerForTest } from '../../../logging.js';
import { parseEnv } from '../../../config/env.js';
import { createV1App } from '../index.js';
import {
  users,
  sessions,
  courses,
  semesters,
  memberships,
  roster_entries,
  assignments,
  ingest_jobs,
  submissions,
  events as eventsTable,
} from '../../../db/schema.js';
import type { DrizzleDb } from '../../../db/client.js';
import { encodeEventCursor, decodeEventCursor } from '../../../services/events/query.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

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

beforeEach(() => {
  _resetConfigForTest();
  _resetLoggerForTest();
});

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

function makeTestEnv() {
  return {
    NODE_ENV: 'test',
    PUBLIC_BASE_URL: 'http://localhost:3000',
    DATABASE_URL: 'postgres://user:pass@localhost:5432/provenance',
    OBJECT_STORAGE_ENDPOINT: 'http://localhost:9000',
    OBJECT_STORAGE_BUCKET: 'test-bucket',
    OBJECT_STORAGE_ACCESS_KEY_ID: 'minioadmin',
    OBJECT_STORAGE_SECRET_ACCESS_KEY: 'minioadmin',
    OBJECT_STORAGE_REGION: 'us-east-1',
    GOOGLE_OAUTH_CLIENT_ID: 'client-id',
    GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
    AUTH_ALLOWED_HOSTED_DOMAINS: '["berkeley.edu"]',
    AUTH_SUPERADMIN_EMAILS: '["admin@berkeley.edu"]',
    AUTH_COOKIE_SIGNING_SECRET: 'test-signing-secret-events-tests-12345678901234',
    SESSION_TTL_DAYS: '14',
    INGEST_MAX_BUNDLE_BYTES: '52428800',
    INGEST_MAX_BATCH_BYTES: '5368709120',
    INGEST_MAX_BATCH_FILES: '10000',
  };
}

async function seedUser(db: DrizzleDb) {
  const id = crypto.randomUUID();
  const [user] = await db
    .insert(users)
    .values({
      id,
      google_subject: `sub-${id}`,
      email: `user-${id}@berkeley.edu`,
      display_name: 'Test User',
    })
    .returning();
  return user!;
}

async function seedSession(db: DrizzleDb, userId: string): Promise<string> {
  const id = `sess-${crypto.randomUUID().replace(/-/g, '')}`.slice(0, 43);
  await db.insert(sessions).values({
    id,
    user_id: userId,
    expires_at: new Date(Date.now() + 14 * 86400_000),
  });
  return id;
}

async function seedCourseAndSemester(db: DrizzleDb) {
  const uid = crypto.randomUUID().slice(0, 8);
  const [course] = await db
    .insert(courses)
    .values({ name: 'CS 61A', slug: `cs61a-${uid}` })
    .returning();
  const [semester] = await db
    .insert(semesters)
    .values({
      course_id: course!.id,
      term: 'fa',
      year: 2024,
      slug: `fa2024-${uid}`,
      display_name: 'Fall 2024',
      filename_convention: '^(?<assignment_id>[a-z0-9_-]+)[-_](?<sid>\\d{6,12})\\.zip$',
    })
    .returning();
  return { course: course!, semester: semester! };
}

async function seedMembership(
  db: DrizzleDb,
  userId: string,
  semesterId: string,
  role: 'admin' | 'grader',
) {
  await db.insert(memberships).values({
    user_id: userId,
    semester_id: semesterId,
    role,
    granted_by: userId,
  });
}

async function seedSubmission(db: DrizzleDb, semesterId: string, userId: string) {
  const [student] = await db
    .insert(roster_entries)
    .values({
      semester_id: semesterId,
      sid: `stu-${crypto.randomUUID().slice(0, 8)}`,
      display_name: 'Alice',
    })
    .returning();

  const [assignment] = await db
    .insert(assignments)
    .values({
      semester_id: semesterId,
      assignment_id_str: `hw-${crypto.randomUUID().slice(0, 6)}`,
      label: 'HW1',
    })
    .returning();

  const [job] = await db
    .insert(ingest_jobs)
    .values({ semester_id: semesterId, uploaded_by: userId, status: 'succeeded' })
    .returning();

  const id = crypto.randomUUID();
  const [sub] = await db
    .insert(submissions)
    .values({
      id,
      semester_id: semesterId,
      assignment_id: assignment!.id,
      student_id: student!.id,
      blob_object_key: `semesters/${semesterId}/submissions/${id}/bundle.zip`,
      blob_sha256: `sha256-${id}`,
      source_filename: 'test.zip',
      ingest_job_id: job!.id,
      version_index: 1,
    })
    .returning();
  return sub!;
}

/**
 * Seed N events into the events table for a submission.
 * Events are numbered seq 1..N; session_id is shared unless per-event override.
 * Returns array of seeded event rows.
 */
async function seedEvents(
  db: DrizzleDb,
  submissionId: string,
  opts: {
    count?: number;
    sessionId?: string;
    kindFn?: (i: number) => string;
    fileFn?: (i: number) => string | undefined;
    tFn?: (i: number) => number;
    wallFn?: (i: number) => Date;
  } = {},
) {
  const n = opts.count ?? 5;
  const sessionId = opts.sessionId ?? crypto.randomUUID();
  const rows = Array.from({ length: n }, (_, i) => {
    const seq = i + 1;
    const kind = opts.kindFn ? opts.kindFn(i) : 'session.heartbeat';
    const path = opts.fileFn ? opts.fileFn(i) : undefined;
    const payload = path !== undefined ? { path } : {};
    return {
      submission_id: submissionId,
      seq,
      session_id: sessionId,
      t: opts.tFn ? opts.tFn(i) : seq * 1000,
      wall: opts.wallFn ? opts.wallFn(i) : new Date(Date.now() + seq * 1000),
      kind,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- jsonb test fixture
      payload: payload as any,
      prev_hash: `prevhash${seq}`,
      hash: `hash${seq}`,
    };
  });
  await db.insert(eventsTable).values(rows);
  return rows;
}

// ---------------------------------------------------------------------------
// §3. Query builder unit tests (no DB needed)
// ---------------------------------------------------------------------------

describe('events query builder — cursor encode/decode', () => {
  it('encodes and decodes a cursor round-trip', () => {
    const cursor = encodeEventCursor(42);
    const decoded = decodeEventCursor(cursor);
    expect(decoded).not.toBeNull();
    expect(decoded!.seq).toBe(42);
  });

  it('returns null for invalid cursor', () => {
    expect(decodeEventCursor('not-valid-base64!!')).toBeNull();
    expect(decodeEventCursor(Buffer.from('{}').toString('base64'))).toBeNull();
    expect(decodeEventCursor(Buffer.from('{"seq":"str"}').toString('base64'))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// §1. GET /submissions/:id/events
// ---------------------------------------------------------------------------

describe('GET /submissions/:id/events', () => {
  it('returns all events for a submission (happy path)', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');
      const sub = await seedSubmission(db, semester.id, user.id);
      await seedEvents(db, sub.id, { count: 5 });

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/submissions/${sub.id}/events`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        items: { seq: number; kind: string }[];
        next_cursor: string | null;
      };
      expect(body.items).toHaveLength(5);
      expect(body.next_cursor).toBeNull();
      // Default order is seq_asc
      expect(body.items[0]!.seq).toBe(1);
      expect(body.items[4]!.seq).toBe(5);
    });
  });

  it('filters by kind', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');
      const sub = await seedSubmission(db, semester.id, user.id);
      // 3 heartbeats + 2 doc.save
      await seedEvents(db, sub.id, {
        count: 5,
        kindFn: (i) => (i < 3 ? 'session.heartbeat' : 'doc.save'),
      });

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/submissions/${sub.id}/events?kind=doc.save`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        items: { kind: string }[];
        total_count: number;
      };
      expect(body.items).toHaveLength(2);
      // total_count is included when kind filter is present
      expect(body.total_count).toBe(2);
      for (const item of body.items) {
        expect(item.kind).toBe('doc.save');
      }
    });
  });

  it('filters by session_id and includes total_count', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');
      const sub = await seedSubmission(db, semester.id, user.id);

      const sessA = crypto.randomUUID();
      const sessB = crypto.randomUUID();
      await db.insert(eventsTable).values([
        {
          submission_id: sub.id,
          seq: 1,
          session_id: sessA,
          t: 1000,
          wall: new Date(),
          kind: 'session.heartbeat',
          payload: {},
          prev_hash: 'p1',
          hash: 'h1',
        },
        {
          submission_id: sub.id,
          seq: 2,
          session_id: sessA,
          t: 2000,
          wall: new Date(),
          kind: 'session.heartbeat',
          payload: {},
          prev_hash: 'p2',
          hash: 'h2',
        },
        {
          submission_id: sub.id,
          seq: 3,
          session_id: sessB,
          t: 3000,
          wall: new Date(),
          kind: 'session.heartbeat',
          payload: {},
          prev_hash: 'p3',
          hash: 'h3',
        },
      ]);

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/submissions/${sub.id}/events?session_id=${sessA}`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        items: { session_id: string }[];
        total_count: number;
      };
      expect(body.items).toHaveLength(2);
      expect(body.total_count).toBe(2);
      for (const item of body.items) {
        expect(item.session_id).toBe(sessA);
      }
    });
  });

  it('filters by file (payload.path)', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');
      const sub = await seedSubmission(db, semester.id, user.id);

      await db.insert(eventsTable).values([
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {
          submission_id: sub.id,
          seq: 1,
          session_id: 'sess1',
          t: 1000,
          wall: new Date(),
          kind: 'doc.change',
          payload: { path: 'main.py' } as any,
          prev_hash: 'p1',
          hash: 'h1',
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {
          submission_id: sub.id,
          seq: 2,
          session_id: 'sess1',
          t: 2000,
          wall: new Date(),
          kind: 'doc.change',
          payload: { path: 'utils.py' } as any,
          prev_hash: 'p2',
          hash: 'h2',
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {
          submission_id: sub.id,
          seq: 3,
          session_id: 'sess1',
          t: 3000,
          wall: new Date(),
          kind: 'doc.change',
          payload: { path: 'main.py' } as any,
          prev_hash: 'p3',
          hash: 'h3',
        },
      ]);

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/submissions/${sub.id}/events?file=main.py`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        items: { seq: number }[];
        total_count: number;
      };
      expect(body.items).toHaveLength(2);
      expect(body.total_count).toBe(2);
      expect(body.items.map((i) => i.seq).sort()).toEqual([1, 3]);
    });
  });

  it('filters by seq_from / seq_to range', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');
      const sub = await seedSubmission(db, semester.id, user.id);
      await seedEvents(db, sub.id, { count: 10 });

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/submissions/${sub.id}/events?seq_from=3&seq_to=6`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: { seq: number }[] };
      expect(body.items).toHaveLength(4); // seqs 3,4,5,6
      expect(body.items[0]!.seq).toBe(3);
      expect(body.items[3]!.seq).toBe(6);
    });
  });

  it('filters by t_from / t_to range', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');
      const sub = await seedSubmission(db, semester.id, user.id);
      // Events with t = 1000, 2000, ..., 5000
      await seedEvents(db, sub.id, { count: 5, tFn: (i) => (i + 1) * 1000 });

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/submissions/${sub.id}/events?t_from=2000&t_to=4000`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: { t: number }[] };
      expect(body.items).toHaveLength(3); // t=2000,3000,4000
      expect(body.items[0]!.t).toBe(2000);
      expect(body.items[2]!.t).toBe(4000);
    });
  });

  it('returns total_count when kind filter active, omits it without', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');
      const sub = await seedSubmission(db, semester.id, user.id);
      await seedEvents(db, sub.id, { count: 3 });

      const app = createV1App();

      // Without kind filter: no total_count
      const resNoKind = await app.fetch(
        new Request(`http://localhost/submissions/${sub.id}/events`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );
      const bodyNoKind = (await resNoKind.json()) as Record<string, unknown>;
      expect('total_count' in bodyNoKind).toBe(false);

      // With kind filter: total_count included
      const resWithKind = await app.fetch(
        new Request(`http://localhost/submissions/${sub.id}/events?kind=session.heartbeat`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );
      const bodyWithKind = (await resWithKind.json()) as Record<string, unknown>;
      expect('total_count' in bodyWithKind).toBe(true);
    });
  });

  it('paginates with cursor (round-trip page1 + page2 = full list)', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');
      const sub = await seedSubmission(db, semester.id, user.id);
      await seedEvents(db, sub.id, { count: 5 });

      const app = createV1App();

      // Page 1: limit=3
      const res1 = await app.fetch(
        new Request(`http://localhost/submissions/${sub.id}/events?limit=3`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );
      expect(res1.status).toBe(200);
      const body1 = (await res1.json()) as {
        items: { seq: number }[];
        next_cursor: string | null;
      };
      expect(body1.items).toHaveLength(3);
      expect(body1.next_cursor).not.toBeNull();
      expect(body1.items.map((i) => i.seq)).toEqual([1, 2, 3]);

      // Page 2: use cursor from page 1
      const res2 = await app.fetch(
        new Request(
          `http://localhost/submissions/${sub.id}/events?limit=3&cursor=${body1.next_cursor!}`,
          { headers: { Cookie: `__Host-prov_sess=${sessionId}` } },
        ),
      );
      expect(res2.status).toBe(200);
      const body2 = (await res2.json()) as {
        items: { seq: number }[];
        next_cursor: string | null;
      };
      expect(body2.items).toHaveLength(2);
      expect(body2.next_cursor).toBeNull();
      expect(body2.items.map((i) => i.seq)).toEqual([4, 5]);
    });
  });

  it('returns events in seq_desc order', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');
      const sub = await seedSubmission(db, semester.id, user.id);
      await seedEvents(db, sub.id, { count: 3 });

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/submissions/${sub.id}/events?order=seq_desc`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: { seq: number }[] };
      expect(body.items.map((i) => i.seq)).toEqual([3, 2, 1]);
    });
  });

  it('returns EVENT_QUERY_LIMIT_EXCEEDED when limit > 2000', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');
      const sub = await seedSubmission(db, semester.id, user.id);

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/submissions/${sub.id}/events?limit=2001`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('EVENT_QUERY_LIMIT_EXCEEDED');
    });
  });

  it('returns EVENT_QUERY_RANGE_INVALID for negative seq_from', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');
      const sub = await seedSubmission(db, semester.id, user.id);

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/submissions/${sub.id}/events?seq_from=-1`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('EVENT_QUERY_RANGE_INVALID');
    });
  });

  it('returns EVENT_QUERY_RANGE_INVALID for out-of-order seq range', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');
      const sub = await seedSubmission(db, semester.id, user.id);

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/submissions/${sub.id}/events?seq_from=10&seq_to=5`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('EVENT_QUERY_RANGE_INVALID');
    });
  });

  it('returns EVENT_QUERY_RANGE_INVALID for out-of-order t range', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');
      const sub = await seedSubmission(db, semester.id, user.id);

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/submissions/${sub.id}/events?t_from=5000&t_to=1000`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('EVENT_QUERY_RANGE_INVALID');
    });
  });

  it('returns EVENT_QUERY_RANGE_INVALID for invalid wall_from string', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');
      const sub = await seedSubmission(db, semester.id, user.id);

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/submissions/${sub.id}/events?wall_from=not-a-date`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('EVENT_QUERY_RANGE_INVALID');
    });
  });

  it('returns EVENT_QUERY_RANGE_INVALID for invalid wall_to string', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');
      const sub = await seedSubmission(db, semester.id, user.id);

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/submissions/${sub.id}/events?wall_to=garbage`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('EVENT_QUERY_RANGE_INVALID');
    });
  });

  it('returns 404 for unknown submission', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/submissions/${crypto.randomUUID()}/events`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );

      expect(res.status).toBe(404);
    });
  });

  it('returns 404 for non-member', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const owner = await seedUser(db);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, owner.id, semester.id, 'admin');
      const sub = await seedSubmission(db, semester.id, owner.id);
      await seedEvents(db, sub.id, { count: 2 });

      const outsider = await seedUser(db);
      const outsiderSession = await seedSession(db, outsider.id);

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/submissions/${sub.id}/events`, {
          headers: { Cookie: `__Host-prov_sess=${outsiderSession}` },
        }),
      );

      expect(res.status).toBe(404);
    });
  });

  it('returns 401 for unauthenticated request', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/submissions/${crypto.randomUUID()}/events`),
      );

      expect(res.status).toBe(401);
    });
  });

  it('filters by wall_from / wall_to range', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');
      const sub = await seedSubmission(db, semester.id, user.id);

      const base = new Date('2024-01-01T00:00:00Z');
      await seedEvents(db, sub.id, {
        count: 5,
        wallFn: (i) => new Date(base.getTime() + i * 60_000), // 1 minute apart
      });

      // Filter to wall range 00:01 - 00:03 (events 1, 2, 3)
      const wallFrom = new Date(base.getTime() + 60_000).toISOString();
      const wallTo = new Date(base.getTime() + 3 * 60_000).toISOString();

      const app = createV1App();
      const res = await app.fetch(
        new Request(
          `http://localhost/submissions/${sub.id}/events?wall_from=${encodeURIComponent(wallFrom)}&wall_to=${encodeURIComponent(wallTo)}`,
          { headers: { Cookie: `__Host-prov_sess=${sessionId}` } },
        ),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: { seq: number }[] };
      expect(body.items.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('supports multiple kind values (OR semantics)', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');
      const sub = await seedSubmission(db, semester.id, user.id);
      await seedEvents(db, sub.id, {
        count: 6,
        kindFn: (i) => {
          if (i < 2) return 'doc.save';
          if (i < 4) return 'doc.change';
          return 'session.heartbeat';
        },
      });

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/submissions/${sub.id}/events?kind=doc.save&kind=doc.change`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        items: { kind: string }[];
        total_count: number;
      };
      expect(body.items).toHaveLength(4);
      expect(body.total_count).toBe(4);
      for (const item of body.items) {
        expect(['doc.save', 'doc.change']).toContain(item.kind);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// §2. GET /submissions/:id/events/:seq
// ---------------------------------------------------------------------------

describe('GET /submissions/:id/events/:seq', () => {
  it('returns single event by seq', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');
      const sub = await seedSubmission(db, semester.id, user.id);
      await seedEvents(db, sub.id, { count: 3 });

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/submissions/${sub.id}/events/2`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { seq: number; kind: string };
      expect(body.seq).toBe(2);
      expect(body.kind).toBe('session.heartbeat');
    });
  });

  it('returns 404 for unknown seq', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');
      const sub = await seedSubmission(db, semester.id, user.id);
      await seedEvents(db, sub.id, { count: 3 });

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/submissions/${sub.id}/events/999`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );

      expect(res.status).toBe(404);
    });
  });

  it('returns 404 for unknown submission', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/submissions/${crypto.randomUUID()}/events/1`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );

      expect(res.status).toBe(404);
    });
  });

  it('returns 404 for non-member', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const owner = await seedUser(db);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, owner.id, semester.id, 'admin');
      const sub = await seedSubmission(db, semester.id, owner.id);
      await seedEvents(db, sub.id, { count: 2 });

      const outsider = await seedUser(db);
      const outsiderSession = await seedSession(db, outsider.id);

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/submissions/${sub.id}/events/1`, {
          headers: { Cookie: `__Host-prov_sess=${outsiderSession}` },
        }),
      );

      expect(res.status).toBe(404);
    });
  });
});
