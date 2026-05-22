/**
 * Ingest routes integration tests (Phase 9a).
 *
 * Tests all ingest endpoints through createV1App() per V18 rule.
 * Both Postgres (withTestDb) and MinIO (withTestMinio) containers are required.
 * The route handler reads storage config from getConfig(), so we wire the test
 * MinIO endpoint into _setConfigForTest().
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import JSZip from 'jszip';
import { eq } from 'drizzle-orm';
import { withTestDb } from '../../../../test/helpers/db.js';
import { withTestMinio } from '../../../../test/helpers/minio.js';
import { waitForAuditRow } from '../../../../test/helpers/audit.js';
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
  ingest_jobs,
  ingest_files,
} from '../../../db/schema.js';
import type { DrizzleDb } from '../../../db/client.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

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
// beforeEach: reset config / logger
// ---------------------------------------------------------------------------

beforeEach(() => {
  _resetConfigForTest();
  _resetLoggerForTest();
});

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

async function seedUser(db: DrizzleDb, overrides?: Partial<typeof users.$inferInsert>) {
  const id = crypto.randomUUID();
  const [user] = await db
    .insert(users)
    .values({
      id,
      google_subject: `sub-${id}`,
      email: `user-${id}@berkeley.edu`,
      display_name: 'Test User',
      is_superadmin: false,
      ...overrides,
    })
    .returning();
  return user!;
}

async function seedSession(
  db: DrizzleDb,
  userId: string,
  expiresAt: Date = new Date(Date.now() + 14 * 86400_000),
): Promise<string> {
  const id = `sess-${crypto.randomUUID().replace(/-/g, '')}`.slice(0, 43);
  await db.insert(sessions).values({ id, user_id: userId, expires_at: expiresAt });
  return id;
}

async function seedCourseAndSemester(db: DrizzleDb) {
  const slug = `cs61a-${crypto.randomUUID().slice(0, 8)}`;
  const [course] = await db.insert(courses).values({ name: 'CS 61A', slug }).returning();
  const [semester] = await db
    .insert(semesters)
    .values({
      course_id: course!.id,
      term: 'fa',
      year: 2024,
      slug: `fa2024-${crypto.randomUUID().slice(0, 8)}`,
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
  await db
    .insert(memberships)
    .values({ user_id: userId, semester_id: semesterId, role, granted_by: userId });
}

async function seedRosterEntry(db: DrizzleDb, semesterId: string) {
  const [entry] = await db
    .insert(roster_entries)
    .values({
      semester_id: semesterId,
      sid: `stu-${crypto.randomUUID().slice(0, 8)}`,
      display_name: 'Test Student',
    })
    .returning();
  return entry!;
}

// ---------------------------------------------------------------------------
// Test env builder (includes MinIO endpoint)
// ---------------------------------------------------------------------------

function makeTestEnv(minioEndpoint: string, minioBucket: string): Record<string, string> {
  return {
    NODE_ENV: 'test',
    PUBLIC_BASE_URL: 'http://localhost:3000',
    DATABASE_URL: 'postgres://user:pass@localhost:5432/provenance', // overridden by mock
    OBJECT_STORAGE_ENDPOINT: minioEndpoint,
    OBJECT_STORAGE_BUCKET: minioBucket,
    OBJECT_STORAGE_ACCESS_KEY_ID: 'minioadmin',
    OBJECT_STORAGE_SECRET_ACCESS_KEY: 'minioadmin',
    OBJECT_STORAGE_REGION: 'us-east-1',
    GOOGLE_OAUTH_CLIENT_ID: 'client-id',
    GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
    AUTH_ALLOWED_HOSTED_DOMAINS: '["berkeley.edu"]',
    AUTH_SUPERADMIN_EMAILS: '["admin@berkeley.edu"]',
    AUTH_COOKIE_SIGNING_SECRET: 'test-signing-secret-for-ingest-tests-123456789',
    SESSION_TTL_DAYS: '14',
    INGEST_MAX_BUNDLE_BYTES: '52428800',
    INGEST_MAX_BATCH_BYTES: '5368709120',
    INGEST_MAX_BATCH_FILES: '10000',
  };
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

function makeZipBytes(_filename = 'test.zip'): Uint8Array {
  // Minimal valid zip: just a tiny zip with a text file inside.
  // For 9a testing we don't need real bundle content — just valid bytes.
  // We use a hard-coded minimal zip (PKZIP end-of-central-directory record).
  // Empty zip: PK\x05\x06 + 18 zero bytes = 22 bytes.
  const emptyZip = new Uint8Array([
    0x50,
    0x4b,
    0x05,
    0x06, // end of central directory signature
    0x00,
    0x00, // disk number
    0x00,
    0x00, // disk with start of central directory
    0x00,
    0x00, // number of entries on this disk
    0x00,
    0x00, // total number of entries
    0x00,
    0x00,
    0x00,
    0x00, // size of central directory
    0x00,
    0x00,
    0x00,
    0x00, // offset of start of central directory
    0x00,
    0x00, // comment length
  ]);
  return emptyZip;
}

function makeMultipartRequest(
  url: string,
  sessionId: string,
  files: Array<{ field: string; name: string; bytes: Uint8Array }>,
): Request {
  const formData = new FormData();
  for (const f of files) {
    formData.append(
      f.field,
      new Blob([f.bytes.buffer as ArrayBuffer], { type: 'application/zip' }),
      f.name,
    );
  }
  return new Request(url, {
    method: 'POST',
    headers: { Cookie: `__Host-prov_sess=${sessionId}` },
    body: formData,
  });
}

// ---------------------------------------------------------------------------
// POST /semesters/:semesterId/ingest — happy paths
// ---------------------------------------------------------------------------

describe('POST /semesters/:semesterId/ingest', () => {
  it('returns 202 with job_id when staging multiple files', async () => {
    await withTestDb(async (db) => {
      await withTestMinio(async ({ client, bucketName }) => {
        _testDb = db;
        try {
          _setConfigForTest(
            parseEnv(makeTestEnv(client.bucketUrl.replace(`/${bucketName}`, ''), bucketName)),
          );
          const admin = await seedUser(db);
          const sessionId = await seedSession(db, admin.id);
          const { semester } = await seedCourseAndSemester(db);
          await seedMembership(db, admin.id, semester.id, 'admin');
          await seedRosterEntry(db, semester.id);

          const app = createV1App();
          const zipBytes = makeZipBytes();
          const req = makeMultipartRequest(
            `http://localhost/semesters/${semester.id}/ingest`,
            sessionId,
            [
              { field: 'files[]', name: 'hw01-123456.zip', bytes: zipBytes },
              { field: 'files[]', name: 'hw01-789012.zip', bytes: zipBytes },
            ],
          );

          const res = await app.fetch(req);
          expect(res.status).toBe(202);
          const body = (await res.json()) as { job_id: string };
          expect(body.job_id).toBeTruthy();

          // Verify ingest_jobs row.
          const jobs = await db.select().from(ingest_jobs).where(eq(ingest_jobs.id, body.job_id));
          expect(jobs).toHaveLength(1);
          expect(jobs[0]!.status).toBe('queued');
          expect(jobs[0]!.semester_id).toBe(semester.id);

          // Verify 2 ingest_files rows.
          const files = await db
            .select()
            .from(ingest_files)
            .where(eq(ingest_files.ingest_job_id, body.job_id));
          expect(files).toHaveLength(2);
          expect(files.every((f) => f.status === 'pending')).toBe(true);
          expect(files.every((f) => f.blob_sha256 !== '')).toBe(true);
        } finally {
          _testDb = null;
        }
      });
    });
  });

  it('returns 202 and stages blobs in MinIO', async () => {
    await withTestDb(async (db) => {
      await withTestMinio(async ({ client, bucketName }) => {
        _testDb = db;
        try {
          _setConfigForTest(
            parseEnv(makeTestEnv(client.bucketUrl.replace(`/${bucketName}`, ''), bucketName)),
          );
          const admin = await seedUser(db);
          const sessionId = await seedSession(db, admin.id);
          const { semester } = await seedCourseAndSemester(db);
          await seedMembership(db, admin.id, semester.id, 'admin');
          await seedRosterEntry(db, semester.id);

          const app = createV1App();
          const zipBytes = makeZipBytes();
          const req = makeMultipartRequest(
            `http://localhost/semesters/${semester.id}/ingest`,
            sessionId,
            [{ field: 'files[]', name: 'hw01-111111.zip', bytes: zipBytes }],
          );

          const res = await app.fetch(req);
          expect(res.status).toBe(202);
          const { job_id } = (await res.json()) as { job_id: string };

          // Verify blob exists in MinIO by retrieving ingest_files row and checking the staging key.
          const [fileRow] = await db
            .select()
            .from(ingest_files)
            .where(eq(ingest_files.ingest_job_id, job_id));
          expect(fileRow).toBeDefined();

          // Verify the blob is retrievable from MinIO.
          const { getBlob } = await import('../../../services/storage/blobs.js');
          const { ingestStagingKey } = await import('../../../services/storage/keys.js');
          const key = ingestStagingKey(job_id, fileRow!.id);
          const stream = await getBlob(client, key);
          // Just check it's a ReadableStream (blob is present).
          expect(stream).toBeInstanceOf(ReadableStream);
          // Cancel the stream to avoid resource leak.
          await stream.cancel();
        } finally {
          _testDb = null;
        }
      });
    });
  });

  it('expands zip-of-zips and stages each inner .zip', async () => {
    await withTestDb(async (db) => {
      await withTestMinio(async ({ client, bucketName }) => {
        _testDb = db;
        try {
          _setConfigForTest(
            parseEnv(makeTestEnv(client.bucketUrl.replace(`/${bucketName}`, ''), bucketName)),
          );
          const admin = await seedUser(db);
          const sessionId = await seedSession(db, admin.id);
          const { semester } = await seedCourseAndSemester(db);
          await seedMembership(db, admin.id, semester.id, 'admin');
          await seedRosterEntry(db, semester.id);

          // Build a zip-of-zips archive.
          const innerZip1 = makeZipBytes('inner1.zip');
          const innerZip2 = makeZipBytes('inner2.zip');

          const outerZip = new JSZip();
          outerZip.file('student1.zip', innerZip1);
          outerZip.file('student2.zip', innerZip2);
          const outerBytes = await outerZip.generateAsync({ type: 'uint8array' });

          const app = createV1App();
          const req = makeMultipartRequest(
            `http://localhost/semesters/${semester.id}/ingest`,
            sessionId,
            [{ field: 'archive', name: 'batch.zip', bytes: outerBytes }],
          );

          const res = await app.fetch(req);
          expect(res.status).toBe(202);
          const { job_id } = (await res.json()) as { job_id: string };

          // Should have 2 ingest_files rows (one per inner zip).
          const files = await db
            .select()
            .from(ingest_files)
            .where(eq(ingest_files.ingest_job_id, job_id));
          expect(files).toHaveLength(2);
          expect(files.every((f) => f.status === 'pending')).toBe(true);
        } finally {
          _testDb = null;
        }
      });
    });
  });

  it('creates audit row for ingest.start', async () => {
    await withTestDb(async (db) => {
      await withTestMinio(async ({ client, bucketName }) => {
        _testDb = db;
        try {
          _setConfigForTest(
            parseEnv(makeTestEnv(client.bucketUrl.replace(`/${bucketName}`, ''), bucketName)),
          );
          const admin = await seedUser(db);
          const sessionId = await seedSession(db, admin.id);
          const { semester } = await seedCourseAndSemester(db);
          await seedMembership(db, admin.id, semester.id, 'admin');
          await seedRosterEntry(db, semester.id);

          const app = createV1App();
          const zipBytes = makeZipBytes();
          const req = makeMultipartRequest(
            `http://localhost/semesters/${semester.id}/ingest`,
            sessionId,
            [{ field: 'files[]', name: 'hw01-555555.zip', bytes: zipBytes }],
          );

          const res = await app.fetch(req);
          expect(res.status).toBe(202);
          const { job_id } = (await res.json()) as { job_id: string };

          // Wait for fire-and-forget audit insert.
          const auditRow = await waitForAuditRow(db, 'ingest.start', job_id);
          expect(auditRow).toBeDefined();
          expect(auditRow!.action).toBe('ingest.start');
          expect(auditRow!.target_type).toBe('ingest_job');
          expect(auditRow!.target_id).toBe(job_id);
        } finally {
          _testDb = null;
        }
      });
    });
  });

  // -----------------------------------------------------------------------
  // Error cases
  // -----------------------------------------------------------------------

  it('returns 422 ROSTER_REQUIRED when semester has no roster entries', async () => {
    await withTestDb(async (db) => {
      await withTestMinio(async ({ client, bucketName }) => {
        _testDb = db;
        try {
          _setConfigForTest(
            parseEnv(makeTestEnv(client.bucketUrl.replace(`/${bucketName}`, ''), bucketName)),
          );
          const admin = await seedUser(db);
          const sessionId = await seedSession(db, admin.id);
          const { semester } = await seedCourseAndSemester(db);
          await seedMembership(db, admin.id, semester.id, 'admin');
          // No roster entries.

          const app = createV1App();
          const zipBytes = makeZipBytes();
          const req = makeMultipartRequest(
            `http://localhost/semesters/${semester.id}/ingest`,
            sessionId,
            [{ field: 'files[]', name: 'hw01-123456.zip', bytes: zipBytes }],
          );

          const res = await app.fetch(req);
          expect(res.status).toBe(422);
          const body = (await res.json()) as { error: { code: string } };
          expect(body.error.code).toBe('ROSTER_REQUIRED');
        } finally {
          _testDb = null;
        }
      });
    });
  });

  it('returns 413 INGEST_BATCH_TOO_LARGE on oversize Content-Length', async () => {
    await withTestDb(async (db) => {
      await withTestMinio(async ({ client, bucketName }) => {
        _testDb = db;
        try {
          // Set a very small max batch size.
          _setConfigForTest(
            parseEnv({
              ...makeTestEnv(client.bucketUrl.replace(`/${bucketName}`, ''), bucketName),
              INGEST_MAX_BATCH_BYTES: '100',
            }),
          );
          const admin = await seedUser(db);
          const sessionId = await seedSession(db, admin.id);
          const { semester } = await seedCourseAndSemester(db);
          await seedMembership(db, admin.id, semester.id, 'admin');
          await seedRosterEntry(db, semester.id);

          const app = createV1App();
          // Send a Content-Length that exceeds the tiny cap.
          const req = new Request(`http://localhost/semesters/${semester.id}/ingest`, {
            method: 'POST',
            headers: {
              Cookie: `__Host-prov_sess=${sessionId}`,
              'Content-Length': '999999',
              'Content-Type': 'multipart/form-data; boundary=----boundary',
            },
            body: '----boundary\r\nContent-Disposition: form-data; name="files[]"; filename="a.zip"\r\n\r\ndata\r\n----boundary--',
          });

          const res = await app.fetch(req);
          expect(res.status).toBe(413);
          const body = (await res.json()) as { error: { code: string } };
          expect(body.error.code).toBe('INGEST_BATCH_TOO_LARGE');
        } finally {
          _testDb = null;
        }
      });
    });
  });

  it('returns 413 INGEST_FILE_TOO_LARGE on oversize individual file', async () => {
    await withTestDb(async (db) => {
      await withTestMinio(async ({ client, bucketName }) => {
        _testDb = db;
        try {
          // Very small per-file cap.
          _setConfigForTest(
            parseEnv({
              ...makeTestEnv(client.bucketUrl.replace(`/${bucketName}`, ''), bucketName),
              INGEST_MAX_BUNDLE_BYTES: '10',
            }),
          );
          const admin = await seedUser(db);
          const sessionId = await seedSession(db, admin.id);
          const { semester } = await seedCourseAndSemester(db);
          await seedMembership(db, admin.id, semester.id, 'admin');
          await seedRosterEntry(db, semester.id);

          const app = createV1App();
          const bigBytes = new Uint8Array(100).fill(0xff); // 100 bytes > 10 byte cap
          const req = makeMultipartRequest(
            `http://localhost/semesters/${semester.id}/ingest`,
            sessionId,
            [{ field: 'files[]', name: 'big.zip', bytes: bigBytes }],
          );

          const res = await app.fetch(req);
          expect(res.status).toBe(413);
          const body = (await res.json()) as { error: { code: string } };
          expect(body.error.code).toBe('INGEST_FILE_TOO_LARGE');
        } finally {
          _testDb = null;
        }
      });
    });
  });

  it('returns 400 INGEST_TOO_MANY_FILES when file count exceeds cap', async () => {
    await withTestDb(async (db) => {
      await withTestMinio(async ({ client, bucketName }) => {
        _testDb = db;
        try {
          _setConfigForTest(
            parseEnv({
              ...makeTestEnv(client.bucketUrl.replace(`/${bucketName}`, ''), bucketName),
              INGEST_MAX_BATCH_FILES: '1',
            }),
          );
          const admin = await seedUser(db);
          const sessionId = await seedSession(db, admin.id);
          const { semester } = await seedCourseAndSemester(db);
          await seedMembership(db, admin.id, semester.id, 'admin');
          await seedRosterEntry(db, semester.id);

          const app = createV1App();
          const zipBytes = makeZipBytes();
          const req = makeMultipartRequest(
            `http://localhost/semesters/${semester.id}/ingest`,
            sessionId,
            [
              { field: 'files[]', name: 'hw01-111111.zip', bytes: zipBytes },
              { field: 'files[]', name: 'hw01-222222.zip', bytes: zipBytes },
            ],
          );

          const res = await app.fetch(req);
          expect(res.status).toBe(400);
          const body = (await res.json()) as { error: { code: string } };
          expect(body.error.code).toBe('INGEST_TOO_MANY_FILES');
        } finally {
          _testDb = null;
        }
      });
    });
  });

  it('returns 401 for unauthenticated requests', async () => {
    await withTestDb(async (db) => {
      await withTestMinio(async ({ client, bucketName }) => {
        _testDb = db;
        try {
          _setConfigForTest(
            parseEnv(makeTestEnv(client.bucketUrl.replace(`/${bucketName}`, ''), bucketName)),
          );
          const { semester } = await seedCourseAndSemester(db);
          const app = createV1App();

          const res = await app.fetch(
            new Request(`http://localhost/semesters/${semester.id}/ingest`, {
              method: 'POST',
            }),
          );
          expect(res.status).toBe(401);
        } finally {
          _testDb = null;
        }
      });
    });
  });

  it('returns 403 for grader (non-admin) role', async () => {
    await withTestDb(async (db) => {
      await withTestMinio(async ({ client, bucketName }) => {
        _testDb = db;
        try {
          _setConfigForTest(
            parseEnv(makeTestEnv(client.bucketUrl.replace(`/${bucketName}`, ''), bucketName)),
          );
          const grader = await seedUser(db);
          const sessionId = await seedSession(db, grader.id);
          const { semester } = await seedCourseAndSemester(db);
          await seedMembership(db, grader.id, semester.id, 'grader');
          await seedRosterEntry(db, semester.id);

          const app = createV1App();
          const zipBytes = makeZipBytes();
          const req = makeMultipartRequest(
            `http://localhost/semesters/${semester.id}/ingest`,
            sessionId,
            [{ field: 'files[]', name: 'hw01-123456.zip', bytes: zipBytes }],
          );

          const res = await app.fetch(req);
          expect(res.status).toBe(403);
        } finally {
          _testDb = null;
        }
      });
    });
  });
});

// ---------------------------------------------------------------------------
// GET /semesters/:semesterId/ingest/jobs
// ---------------------------------------------------------------------------

describe('GET /semesters/:semesterId/ingest/jobs', () => {
  it('returns paginated job list for a semester member', async () => {
    await withTestDb(async (db) => {
      await withTestMinio(async ({ client, bucketName }) => {
        _testDb = db;
        try {
          _setConfigForTest(
            parseEnv(makeTestEnv(client.bucketUrl.replace(`/${bucketName}`, ''), bucketName)),
          );
          const admin = await seedUser(db);
          const sessionId = await seedSession(db, admin.id);
          const { semester } = await seedCourseAndSemester(db);
          await seedMembership(db, admin.id, semester.id, 'admin');
          await seedRosterEntry(db, semester.id);

          // Create 3 jobs via the POST endpoint.
          const app = createV1App();
          const zipBytes = makeZipBytes();

          for (let i = 0; i < 3; i++) {
            const req = makeMultipartRequest(
              `http://localhost/semesters/${semester.id}/ingest`,
              sessionId,
              [{ field: 'files[]', name: `hw0${i}-123456.zip`, bytes: zipBytes }],
            );
            const res = await app.fetch(req);
            expect(res.status).toBe(202);
          }

          // List with limit=2.
          const listRes = await app.fetch(
            new Request(`http://localhost/semesters/${semester.id}/ingest/jobs?limit=2`, {
              headers: { Cookie: `__Host-prov_sess=${sessionId}` },
            }),
          );
          expect(listRes.status).toBe(200);
          const body = (await listRes.json()) as { items: unknown[]; next_cursor: string | null };
          expect(body.items).toHaveLength(2);
          expect(body.next_cursor).toBeTruthy();

          // Get next page.
          const page2Res = await app.fetch(
            new Request(
              `http://localhost/semesters/${semester.id}/ingest/jobs?limit=2&cursor=${body.next_cursor}`,
              { headers: { Cookie: `__Host-prov_sess=${sessionId}` } },
            ),
          );
          expect(page2Res.status).toBe(200);
          const body2 = (await page2Res.json()) as { items: unknown[]; next_cursor: string | null };
          expect(body2.items).toHaveLength(1);
          expect(body2.next_cursor).toBeNull();
        } finally {
          _testDb = null;
        }
      });
    });
  });
});

// ---------------------------------------------------------------------------
// POST /semesters/:semesterId/ingest/jobs/:jobId/cancel
// ---------------------------------------------------------------------------

describe('POST /semesters/:semesterId/ingest/jobs/:jobId/cancel', () => {
  it('cancels a queued job and creates an audit row', async () => {
    await withTestDb(async (db) => {
      await withTestMinio(async ({ client, bucketName }) => {
        _testDb = db;
        try {
          _setConfigForTest(
            parseEnv(makeTestEnv(client.bucketUrl.replace(`/${bucketName}`, ''), bucketName)),
          );
          const admin = await seedUser(db);
          const sessionId = await seedSession(db, admin.id);
          const { semester } = await seedCourseAndSemester(db);
          await seedMembership(db, admin.id, semester.id, 'admin');
          await seedRosterEntry(db, semester.id);

          const app = createV1App();
          const zipBytes = makeZipBytes();

          // Create a job.
          const postRes = await app.fetch(
            makeMultipartRequest(`http://localhost/semesters/${semester.id}/ingest`, sessionId, [
              { field: 'files[]', name: 'hw01-123456.zip', bytes: zipBytes },
            ]),
          );
          expect(postRes.status).toBe(202);
          const { job_id } = (await postRes.json()) as { job_id: string };

          // Cancel it.
          const cancelRes = await app.fetch(
            new Request(`http://localhost/semesters/${semester.id}/ingest/jobs/${job_id}/cancel`, {
              method: 'POST',
              headers: { Cookie: `__Host-prov_sess=${sessionId}` },
            }),
          );
          expect(cancelRes.status).toBe(202);
          const cancelBody = (await cancelRes.json()) as {
            ok: boolean;
            cancelled: boolean;
            previous_status: string;
          };
          expect(cancelBody.ok).toBe(true);
          expect(cancelBody.cancelled).toBe(true);
          expect(cancelBody.previous_status).toBe('queued');

          // Verify DB status.
          const [job] = await db.select().from(ingest_jobs).where(eq(ingest_jobs.id, job_id));
          expect(job!.status).toBe('cancelled');

          // Verify audit.
          const auditRow = await waitForAuditRow(db, 'ingest.cancel', job_id);
          expect(auditRow).toBeDefined();
          expect(auditRow!.action).toBe('ingest.cancel');
          expect(auditRow!.target_id).toBe(job_id);
        } finally {
          _testDb = null;
        }
      });
    });
  });

  it('returns 404 for non-existent job', async () => {
    await withTestDb(async (db) => {
      await withTestMinio(async ({ client, bucketName }) => {
        _testDb = db;
        try {
          _setConfigForTest(
            parseEnv(makeTestEnv(client.bucketUrl.replace(`/${bucketName}`, ''), bucketName)),
          );
          const admin = await seedUser(db);
          const sessionId = await seedSession(db, admin.id);
          const { semester } = await seedCourseAndSemester(db);
          await seedMembership(db, admin.id, semester.id, 'admin');

          const app = createV1App();
          const nonExistent = crypto.randomUUID();
          const res = await app.fetch(
            new Request(
              `http://localhost/semesters/${semester.id}/ingest/jobs/${nonExistent}/cancel`,
              {
                method: 'POST',
                headers: { Cookie: `__Host-prov_sess=${sessionId}` },
              },
            ),
          );
          expect(res.status).toBe(404);
        } finally {
          _testDb = null;
        }
      });
    });
  });

  it('returns 409 INGEST_JOB_NOT_CANCELLABLE when job is already terminal (Important 4)', async () => {
    await withTestDb(async (db) => {
      await withTestMinio(async ({ client, bucketName }) => {
        _testDb = db;
        try {
          _setConfigForTest(
            parseEnv(makeTestEnv(client.bucketUrl.replace(`/${bucketName}`, ''), bucketName)),
          );
          const admin = await seedUser(db);
          const sessionId = await seedSession(db, admin.id);
          const { semester } = await seedCourseAndSemester(db);
          await seedMembership(db, admin.id, semester.id, 'admin');
          await seedRosterEntry(db, semester.id);

          const app = createV1App();
          const zipBytes = makeZipBytes();

          // Create a job.
          const postRes = await app.fetch(
            makeMultipartRequest(`http://localhost/semesters/${semester.id}/ingest`, sessionId, [
              { field: 'files[]', name: 'hw01-123456.zip', bytes: zipBytes },
            ]),
          );
          expect(postRes.status).toBe(202);
          const { job_id } = (await postRes.json()) as { job_id: string };

          // Force the job into 'failed' state directly in the DB.
          const { failIngestJob } = await import('../../../services/ingest/job-control.js');
          await failIngestJob(db, job_id, 'forced terminal for test');

          // Attempt to cancel the terminal job.
          const cancelRes = await app.fetch(
            new Request(`http://localhost/semesters/${semester.id}/ingest/jobs/${job_id}/cancel`, {
              method: 'POST',
              headers: { Cookie: `__Host-prov_sess=${sessionId}` },
            }),
          );
          expect(cancelRes.status).toBe(409);
          const body = (await cancelRes.json()) as {
            error: { code: string; details: { previous_status: string } };
          };
          expect(body.error.code).toBe('INGEST_JOB_NOT_CANCELLABLE');
          expect(body.error.details.previous_status).toBe('failed');
        } finally {
          _testDb = null;
        }
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Regression: Critical 1 — orphaned ingest_jobs row when staging fails
// ---------------------------------------------------------------------------

describe('POST /semesters/:semesterId/ingest — staging failure compensation (Critical 1)', () => {
  it('marks job failed (not orphaned as queued) when stageBlob throws on second file', async () => {
    await withTestDb(async (db) => {
      await withTestMinio(async ({ client, bucketName }) => {
        _testDb = db;
        try {
          _setConfigForTest(
            parseEnv(makeTestEnv(client.bucketUrl.replace(`/${bucketName}`, ''), bucketName)),
          );
          const admin = await seedUser(db);
          const sessionId = await seedSession(db, admin.id);
          const { semester } = await seedCourseAndSemester(db);
          await seedMembership(db, admin.id, semester.id, 'admin');
          await seedRosterEntry(db, semester.id);

          // Inject a faulty stageBlob that succeeds on call 1, throws on call 2.
          const stageBlobModule = await import('../../../services/ingest/stage-blob.js');
          let callCount = 0;
          const originalStageBlob = stageBlobModule.stageBlob;
          const spy = vi
            .spyOn(stageBlobModule, 'stageBlob')
            .mockImplementation(async (...args: Parameters<typeof stageBlobModule.stageBlob>) => {
              callCount++;
              if (callCount === 2) {
                throw new Error('simulated MinIO failure on file 2');
              }
              return originalStageBlob(...args);
            });

          const app = createV1App();
          const zipBytes = makeZipBytes();
          const res = await app.fetch(
            makeMultipartRequest(`http://localhost/semesters/${semester.id}/ingest`, sessionId, [
              { field: 'files[]', name: 'hw01-111111.zip', bytes: zipBytes },
              { field: 'files[]', name: 'hw01-222222.zip', bytes: zipBytes },
            ]),
          );

          spy.mockRestore();

          // Route should return 500 (unhandled staging error re-thrown).
          expect(res.status).toBe(500);

          // The ingest_jobs row must exist and be status='failed' (not 'queued').
          const jobs = await db
            .select()
            .from(ingest_jobs)
            .where(eq(ingest_jobs.semester_id, semester.id));
          expect(jobs).toHaveLength(1);
          expect(jobs[0]!.status).toBe('failed');

          // The first file's ingest_files row should exist (it was inserted before failure).
          const files = await db
            .select()
            .from(ingest_files)
            .where(eq(ingest_files.ingest_job_id, jobs[0]!.id));
          expect(files).toHaveLength(1);
          expect(files[0]!.status).toBe('pending');
        } finally {
          _testDb = null;
        }
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Regression: Critical 2 — zip-of-zips total-uncompressed cap (zip-bomb guard)
// ---------------------------------------------------------------------------

describe('POST /semesters/:semesterId/ingest — zip-bomb guard (Critical 2)', () => {
  it('returns 413 INGEST_BATCH_TOO_LARGE when outer zip decompresses beyond batch cap', async () => {
    await withTestDb(async (db) => {
      await withTestMinio(async ({ client, bucketName }) => {
        _testDb = db;
        try {
          // Set a small batch cap so we can craft a test zip without actual large data.
          _setConfigForTest(
            parseEnv({
              ...makeTestEnv(client.bucketUrl.replace(`/${bucketName}`, ''), bucketName),
              INGEST_MAX_BATCH_BYTES: '100',
              INGEST_MAX_BUNDLE_BYTES: '52428800',
            }),
          );
          const admin = await seedUser(db);
          const sessionId = await seedSession(db, admin.id);
          const { semester } = await seedCourseAndSemester(db);
          await seedMembership(db, admin.id, semester.id, 'admin');
          await seedRosterEntry(db, semester.id);

          // Build a zip-of-zips whose combined uncompressed size exceeds the 100-byte cap.
          // Each inner entry is a small but compressible payload > 50 bytes uncompressed.
          const inner1 = new Uint8Array(60).fill(0x41);
          const inner2 = new Uint8Array(60).fill(0x42);

          const innerZip1 = new JSZip();
          innerZip1.file('data.txt', inner1);
          const inner1Bytes = await innerZip1.generateAsync({ type: 'uint8array' });

          const innerZip2 = new JSZip();
          innerZip2.file('data.txt', inner2);
          const inner2Bytes = await innerZip2.generateAsync({ type: 'uint8array' });

          // The outer zip holds two inner .zip files.
          // When expanded, total uncompressed = inner1Bytes + inner2Bytes > 100 bytes.
          const outerZip = new JSZip();
          outerZip.file('student1.zip', inner1Bytes);
          outerZip.file('student2.zip', inner2Bytes);
          const outerBytes = await outerZip.generateAsync({ type: 'uint8array' });

          const app = createV1App();
          const res = await app.fetch(
            makeMultipartRequest(`http://localhost/semesters/${semester.id}/ingest`, sessionId, [
              { field: 'archive', name: 'batch.zip', bytes: outerBytes },
            ]),
          );

          expect(res.status).toBe(413);
          const body = (await res.json()) as { error: { code: string } };
          expect(body.error.code).toBe('INGEST_BATCH_TOO_LARGE');
        } finally {
          _testDb = null;
        }
      });
    });
  });
});
