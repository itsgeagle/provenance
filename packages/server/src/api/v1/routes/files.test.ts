/**
 * File content + provenance endpoints integration tests (Phase 18).
 *
 * Tests all file endpoints through createV1App() per V18 rule.
 *
 * Test groups:
 *   1. GET /submissions/:id/files/:path/content — happy path
 *   2. GET /submissions/:id/files/:path/content — with at_seq param
 *   3. GET /submissions/:id/files/:path/content — non-existent path → 404
 *   4. GET /submissions/:id/files/:path/content — tainted file → 200 + warning
 *   5. GET /submissions/:id/files/:path/content — Cache-Control header
 *   6. GET /submissions/:id/files/:path/provenance — happy path + RLE coverage
 *   7. GET /submissions/:id/files/:path/provenance — runs cover full content length
 *   8. GET /submissions/:id/files/:path/content — unauthenticated → 401
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
  events,
  per_file_stats,
} from '../../../db/schema.js';
import type { DrizzleDb } from '../../../db/client.js';
import { _resetReconstructionCacheForTest } from '../../../services/reconstruction.js';

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
  _resetReconstructionCacheForTest();
});

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

function makeTestEnv(extra?: Record<string, string>) {
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
    AUTH_COOKIE_SIGNING_SECRET: 'test-signing-secret-files-tests-123456789012',
    SESSION_TTL_DAYS: '14',
    INGEST_MAX_BUNDLE_BYTES: '52428800',
    INGEST_MAX_BATCH_BYTES: '5368709120',
    INGEST_MAX_BATCH_FILES: '10000',
    RECONSTRUCTION_CACHE_SIZE: '100',
    ...extra,
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

async function seedMembership(db: DrizzleDb, userId: string, semesterId: string) {
  await db.insert(memberships).values({
    user_id: userId,
    semester_id: semesterId,
    role: 'admin',
    granted_by: userId,
  });
}

async function seedSubmissionWithFile(
  db: DrizzleDb,
  semesterId: string,
  opts?: { tainted?: boolean },
) {
  const uid = crypto.randomUUID().slice(0, 8);
  const userId = crypto.randomUUID();
  await db.insert(users).values({
    id: userId,
    google_subject: `ingest-${userId}`,
    email: `ingest-${uid}@test.com`,
    display_name: 'Ingest User',
  });

  const [student] = await db
    .insert(roster_entries)
    .values({ semester_id: semesterId, sid: `s-${uid}`, display_name: 'Alice' })
    .returning();

  const [assignment] = await db
    .insert(assignments)
    .values({ semester_id: semesterId, assignment_id_str: `hw-${uid}`, label: 'HW1' })
    .returning();

  const [job] = await db
    .insert(ingest_jobs)
    .values({ semester_id: semesterId, uploaded_by: userId, status: 'succeeded' })
    .returning();

  const submissionId = crypto.randomUUID();
  await db.insert(submissions).values({
    id: submissionId,
    semester_id: semesterId,
    assignment_id: assignment!.id,
    student_id: student!.id,
    blob_object_key: `semesters/${semesterId}/submissions/${submissionId}/bundle.zip`,
    blob_sha256: `sha256-${submissionId}`,
    source_filename: 'test.zip',
    ingest_job_id: job!.id,
    version_index: 1,
  });

  const sessionId = crypto.randomUUID();

  // Seed doc.open (initial content "hello") + doc.change (appends " world").
  await db.insert(events).values([
    {
      submission_id: submissionId,
      seq: 0,
      session_id: sessionId,
      t: 0,
      wall: new Date('2024-01-01T10:00:00Z'),
      kind: 'doc.open',
      payload: { path: 'main.py', content: 'hello' },
      prev_hash: '0000',
      hash: 'hash0',
    },
    {
      submission_id: submissionId,
      seq: 1,
      session_id: sessionId,
      t: 1000,
      wall: new Date('2024-01-01T10:00:01Z'),
      kind: 'doc.change',
      payload: {
        path: 'main.py',
        deltas: [
          {
            range: { start: { line: 0, character: 5 }, end: { line: 0, character: 5 } },
            text: ' world',
          },
        ],
      },
      prev_hash: 'hash0',
      hash: 'hash1',
    },
    {
      submission_id: submissionId,
      seq: 2,
      session_id: sessionId,
      t: 2000,
      wall: new Date('2024-01-01T10:00:02Z'),
      kind: 'doc.save',
      payload: { path: 'main.py', sha256: 'abc123' },
      prev_hash: 'hash1',
      hash: 'hash2',
    },
  ]);

  // Seed per_file_stats row.
  await db.insert(per_file_stats).values({
    submission_id: submissionId,
    file_path: 'main.py',
    chars_typed: 6,
    chars_pasted: 0,
    chars_external_change_delta: 0,
    saves: 1,
    final_length: 11,
    start_length: 0,
    reconstruction_tainted: opts?.tainted ?? false,
  });

  return { submissionId, sessionId };
}

// ---------------------------------------------------------------------------
// §1. GET /submissions/:id/files/:path/content — happy path
// ---------------------------------------------------------------------------

describe('GET /submissions/:id/files/:path/content', () => {
  it('happy path: returns correct content + metadata', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id);

      const { submissionId } = await seedSubmissionWithFile(db, semester.id);

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/submissions/${submissionId}/files/main.py/content`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body['submission_id']).toBe(submissionId);
      expect(body['path']).toBe('main.py');
      expect(body['content']).toBe('hello world');
      expect(typeof body['computed_at_ms']).toBe('number');
    });
  });

  // -------------------------------------------------------------------------
  // §2. GET /submissions/:id/files/:path/content — with at_seq
  // -------------------------------------------------------------------------

  it('with at_seq=1: reconstruction stops before doc.change (only "hello")', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id);

      const { submissionId } = await seedSubmissionWithFile(db, semester.id);

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/submissions/${submissionId}/files/main.py/content?at_seq=1`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      // at_seq=1 is exclusive upper bound — doc.open (seq=0) is included, doc.change (seq=1) is NOT.
      expect(body['content']).toBe('hello');
      expect(body['at_seq']).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // §3. Non-existent path → 404 FILE_NOT_FOUND
  // -------------------------------------------------------------------------

  it('returns 404 FILE_NOT_FOUND for path not in per_file_stats', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id);

      const { submissionId } = await seedSubmissionWithFile(db, semester.id);

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/submissions/${submissionId}/files/nonexistent.py/content`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );

      expect(res.status).toBe(404);
      const body = (await res.json()) as Record<string, unknown>;
      const error = body['error'] as Record<string, unknown>;
      expect(error['code']).toBe('FILE_NOT_FOUND');
    });
  });

  // -------------------------------------------------------------------------
  // §4. Tainted file → 200 with empty content + warning
  // -------------------------------------------------------------------------

  it('tainted file returns 200 with content:"" and warning field', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id);

      const { submissionId } = await seedSubmissionWithFile(db, semester.id, { tainted: true });

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/submissions/${submissionId}/files/main.py/content`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body['content']).toBe('');
      const warning = body['warning'] as Record<string, unknown>;
      expect(warning['code']).toBe('FILE_RECONSTRUCTION_TAINTED');
    });
  });

  // -------------------------------------------------------------------------
  // §5. Cache-Control header
  // -------------------------------------------------------------------------

  it('sets Cache-Control: max-age=60, private', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id);

      const { submissionId } = await seedSubmissionWithFile(db, semester.id);

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/submissions/${submissionId}/files/main.py/content`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );

      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('max-age=60, private');
    });
  });

  // -------------------------------------------------------------------------
  // §8. Unauthenticated → 401
  // -------------------------------------------------------------------------

  it('returns 401 without auth cookie', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      // We just need a valid-looking submissionId.
      const fakeId = crypto.randomUUID();
      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/submissions/${fakeId}/files/main.py/content`),
      );

      expect(res.status).toBe(401);
    });
  });
});

// ---------------------------------------------------------------------------
// §6. GET /submissions/:id/files/:path/provenance — happy path
// ---------------------------------------------------------------------------

describe('GET /submissions/:id/files/:path/provenance', () => {
  it('happy path: returns RLE provenance with correct shape', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id);

      const { submissionId } = await seedSubmissionWithFile(db, semester.id);

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/submissions/${submissionId}/files/main.py/provenance`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body['submission_id']).toBe(submissionId);
      expect(body['path']).toBe('main.py');
      expect(typeof body['length']).toBe('number');
      const provenance = body['provenance'] as Array<Record<string, unknown>>;
      expect(Array.isArray(provenance)).toBe(true);
      // Each run must have offset, length, kind, event_seq fields.
      for (const run of provenance) {
        expect(typeof run['offset']).toBe('number');
        expect(typeof run['length']).toBe('number');
        expect(typeof run['kind']).toBe('string');
        expect(typeof run['event_seq']).toBe('number');
      }
    });
  });

  // -------------------------------------------------------------------------
  // §7. Provenance runs cover the full content length
  // -------------------------------------------------------------------------

  it('provenance runs cover the full content length', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id);

      const { submissionId } = await seedSubmissionWithFile(db, semester.id);

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/submissions/${submissionId}/files/main.py/provenance`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      const totalLength = body['length'] as number;
      const provenance = body['provenance'] as Array<{ offset: number; length: number }>;

      // Sum of run lengths must equal total content length.
      const sumOfRunLengths = provenance.reduce((sum, r) => sum + r.length, 0);
      expect(sumOfRunLengths).toBe(totalLength);

      // Runs must be non-overlapping and contiguous.
      let expectedOffset = 0;
      for (const run of provenance) {
        expect(run.offset).toBe(expectedOffset);
        expectedOffset += run.length;
      }
      expect(expectedOffset).toBe(totalLength);
    });
  });
});
