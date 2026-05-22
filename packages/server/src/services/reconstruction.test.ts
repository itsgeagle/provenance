/**
 * Unit/integration tests for services/reconstruction.ts — Phase 18.
 *
 * Tests:
 *   1. Cold reconstruction returns expected content for a synthetic bundle.
 *   2. Cache hit returns same object reference (no DB round-trip).
 *   3. Eviction: fill cache past capacity → oldest entries evicted.
 *   4. Tainted file path → tainted flag returned correctly.
 *   5. Missing file path → throws FILE_NOT_FOUND.
 *
 * Uses testcontainers Postgres (not mocked) for realistic DB state.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { withTestDb } from '../../test/helpers/db.js';
import { _resetConfigForTest, _setConfigForTest } from '../config/index.js';
import { _resetLoggerForTest } from '../logging.js';
import { parseEnv } from '../config/env.js';
import {
  users,
  courses,
  semesters,
  roster_entries,
  assignments,
  ingest_jobs,
  submissions,
  events,
  per_file_stats,
} from '../db/schema.js';
import type { DrizzleDb } from '../db/client.js';
import { reconstructFile, _resetReconstructionCacheForTest } from './reconstruction.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

// ---------------------------------------------------------------------------
// Helpers
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
    AUTH_COOKIE_SIGNING_SECRET: 'test-signing-secret-reconstruction-tests-1234567',
    SESSION_TTL_DAYS: '14',
    INGEST_MAX_BUNDLE_BYTES: '52428800',
    INGEST_MAX_BATCH_BYTES: '5368709120',
    INGEST_MAX_BATCH_FILES: '10000',
    ...extra,
  };
}

async function seedSubmission(db: DrizzleDb) {
  const uid = crypto.randomUUID();

  const [user] = await db
    .insert(users)
    .values({
      google_subject: `sub-${uid}`,
      email: `u-${uid}@test.com`,
      display_name: 'U',
    })
    .returning();

  const [course] = await db
    .insert(courses)
    .values({ name: 'CS', slug: `c-${uid.slice(0, 8)}` })
    .returning();

  const [semester] = await db
    .insert(semesters)
    .values({
      course_id: course!.id,
      term: 'fa',
      year: 2024,
      slug: `fa24-${uid.slice(0, 8)}`,
      display_name: 'Fall 2024',
      filename_convention: '(?<sid>\\d+)',
    })
    .returning();

  const [student] = await db
    .insert(roster_entries)
    .values({ semester_id: semester!.id, sid: `s-${uid.slice(0, 6)}`, display_name: 'Alice' })
    .returning();

  const [assignment] = await db
    .insert(assignments)
    .values({ semester_id: semester!.id, assignment_id_str: 'hw1', label: 'HW1' })
    .returning();

  const [job] = await db
    .insert(ingest_jobs)
    .values({ semester_id: semester!.id, uploaded_by: user!.id, status: 'succeeded' })
    .returning();

  const submissionId = crypto.randomUUID();

  await db.insert(submissions).values({
    id: submissionId,
    semester_id: semester!.id,
    assignment_id: assignment!.id,
    student_id: student!.id,
    blob_object_key: `semesters/${semester!.id}/submissions/${submissionId}/bundle.zip`,
    blob_sha256: `sha256-${submissionId}`,
    source_filename: 'test.zip',
    ingest_job_id: job!.id,
    version_index: 1,
  });

  return { submissionId, semesterId: semester!.id };
}

/**
 * Insert a minimal doc.open + doc.change event sequence for file `main.py`.
 * doc.open seeds content 'hello'; doc.change appends ' world'.
 * Final content: 'hello world'.
 */
async function seedFileEvents(db: DrizzleDb, submissionId: string, sessionId: string) {
  const events_rows = [
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
  ];

  await db.insert(events).values(events_rows);
}

async function seedPerFileStats(
  db: DrizzleDb,
  submissionId: string,
  filePath: string,
  opts?: { tainted?: boolean },
) {
  await db.insert(per_file_stats).values({
    submission_id: submissionId,
    file_path: filePath,
    chars_typed: 0,
    chars_pasted: 0,
    chars_external_change_delta: 0,
    saves: 0,
    final_length: 11,
    start_length: 0,
    reconstruction_tainted: opts?.tainted ?? false,
  });
}

beforeEach(() => {
  _resetConfigForTest();
  _resetLoggerForTest();
  _resetReconstructionCacheForTest();
});

// ---------------------------------------------------------------------------
// §1. Cold reconstruction
// ---------------------------------------------------------------------------

describe('reconstructFile — cold reconstruction', () => {
  it('returns expected content from doc.open + doc.change events', async () => {
    await withTestDb(async (db) => {
      _setConfigForTest(parseEnv(makeTestEnv()));

      const { submissionId } = await seedSubmission(db);
      const sessionId = crypto.randomUUID();
      await seedFileEvents(db, submissionId, sessionId);
      await seedPerFileStats(db, submissionId, 'main.py');

      const result = await reconstructFile(db, submissionId, 'main.py');

      expect(result.content).toBe('hello world');
      // provenance should have 11 entries (one per char)
      expect(result.provenance).toHaveLength(11);
      // First 5 chars come from doc.open (seq=0), next 6 from doc.change (seq=1).
      expect(result.provenance.slice(0, 5).every((v) => v === 0)).toBe(true);
      expect(result.provenance.slice(5).every((v) => v === 1)).toBe(true);
      expect(result.tainted).toBe(false);
      expect(result.computedAtMs).toBeGreaterThanOrEqual(0);
    });
  });
});

// ---------------------------------------------------------------------------
// §2. Cache hit
// ---------------------------------------------------------------------------

describe('reconstructFile — cache hit', () => {
  it('returns same object reference on second call', async () => {
    await withTestDb(async (db) => {
      _setConfigForTest(parseEnv(makeTestEnv()));

      const { submissionId } = await seedSubmission(db);
      const sessionId = crypto.randomUUID();
      await seedFileEvents(db, submissionId, sessionId);
      await seedPerFileStats(db, submissionId, 'main.py');

      const first = await reconstructFile(db, submissionId, 'main.py');
      const t0 = Date.now();
      const second = await reconstructFile(db, submissionId, 'main.py');
      const elapsed = Date.now() - t0;

      // Same object reference proves no recomputation.
      expect(second).toBe(first);
      // Cache hit should be very fast (no DB round-trip).
      expect(elapsed).toBeLessThan(50);
    });
  });
});

// ---------------------------------------------------------------------------
// §3. Cache eviction
// ---------------------------------------------------------------------------

describe('reconstructFile — cache eviction', () => {
  it('evicts oldest entry when capacity is exceeded', async () => {
    await withTestDb(async (db) => {
      // Set cache capacity to 2 so we can test eviction easily.
      _setConfigForTest(parseEnv(makeTestEnv({ RECONSTRUCTION_CACHE_SIZE: '2' })));

      // Seed 3 submissions, each with a file.
      const submissions_data: Array<{ submissionId: string; sessionId: string }> = [];
      for (let i = 0; i < 3; i++) {
        const { submissionId } = await seedSubmission(db);
        const sessionId = crypto.randomUUID();
        await seedFileEvents(db, submissionId, sessionId);
        await seedPerFileStats(db, submissionId, 'main.py');
        submissions_data.push({ submissionId, sessionId });
      }

      const [s0, s1, s2] = submissions_data;

      // Reconstruct file for submission 0 → cached.
      const first0 = await reconstructFile(db, s0!.submissionId, 'main.py');
      // Reconstruct file for submission 1 → cached (cache full at capacity=2).
      await reconstructFile(db, s1!.submissionId, 'main.py');
      // Reconstruct file for submission 2 → evicts submission 0.
      await reconstructFile(db, s2!.submissionId, 'main.py');

      // submission 0 was evicted; next call recomputes (new object).
      const second0 = await reconstructFile(db, s0!.submissionId, 'main.py');
      expect(second0).not.toBe(first0);
      expect(second0.content).toBe(first0.content); // Same content, different object.
    });
  });
});

// ---------------------------------------------------------------------------
// §4. Tainted file
// ---------------------------------------------------------------------------

describe('reconstructFile — tainted file', () => {
  it('returns tainted=true when per_file_stats.reconstruction_tainted is true', async () => {
    await withTestDb(async (db) => {
      _setConfigForTest(parseEnv(makeTestEnv()));

      const { submissionId } = await seedSubmission(db);
      const sessionId = crypto.randomUUID();
      await seedFileEvents(db, submissionId, sessionId);
      await seedPerFileStats(db, submissionId, 'main.py', { tainted: true });

      const result = await reconstructFile(db, submissionId, 'main.py');

      expect(result.tainted).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// §5. Missing file path
// ---------------------------------------------------------------------------

describe('reconstructFile — missing file path', () => {
  it('throws FILE_NOT_FOUND for path not in per_file_stats', async () => {
    await withTestDb(async (db) => {
      _setConfigForTest(parseEnv(makeTestEnv()));

      const { submissionId } = await seedSubmission(db);
      // Do NOT seed per_file_stats or events for this path.

      await expect(reconstructFile(db, submissionId, 'nonexistent.py')).rejects.toMatchObject({
        code: 'FILE_NOT_FOUND',
      });
    });
  });
});
