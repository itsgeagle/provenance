/**
 * Integration tests for ingest job-control (enqueueIngestJob, finalizeIngestJob, cancelIngestJob).
 *
 * Uses withTestDb — requires Docker.
 */

import { vi, describe, it, expect } from 'vitest';

// Mock the logging module so tests don't require a fully-configured env singleton.
vi.mock('../../logging.js', () => ({
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    debug: () => {},
    error: () => {},
  }),
}));

import { eq } from 'drizzle-orm';
import { withTestDb } from '../../../test/helpers/db.js';
import {
  enqueueIngestJob,
  finalizeIngestJob,
  cancelIngestJob,
  failIngestJob,
  markStagingStarted,
  markStagingComplete,
  maybeEnqueueFinalize,
} from './job-control.js';
import { users, courses, semesters, ingest_jobs, ingest_files } from '../../db/schema.js';
import type { DrizzleDb } from '../../db/client.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

async function seedUser(db: DrizzleDb) {
  const id = crypto.randomUUID();
  const [user] = await db
    .insert(users)
    .values({
      id,
      google_subject: `sub-${id}`,
      email: `user-${id}@berkeley.edu`,
      display_name: 'Test User',
      is_superadmin: false,
    })
    .returning();
  return user!;
}

async function seedSemester(db: DrizzleDb, _userId: string) {
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
      filename_convention: '(?<sid>\\d+)',
    })
    .returning();
  return semester!;
}

// ---------------------------------------------------------------------------
// enqueueIngestJob
// ---------------------------------------------------------------------------

describe('enqueueIngestJob', () => {
  it('inserts a row with status=queued and returns jobId', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db, user.id);

      const { jobId } = await enqueueIngestJob(db, semester.id, user.id);
      expect(jobId).toBeTruthy();

      const rows = await db.select().from(ingest_jobs).where(eq(ingest_jobs.id, jobId));
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.status).toBe('queued');
      expect(row.semester_id).toBe(semester.id);
      expect(row.uploaded_by).toBe(user.id);
      expect(row.summary).toEqual({});
      expect(row.started_at).toBeNull();
      expect(row.completed_at).toBeNull();
    });
  });

  it('creates distinct jobIds for multiple calls', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db, user.id);

      const { jobId: j1 } = await enqueueIngestJob(db, semester.id, user.id);
      const { jobId: j2 } = await enqueueIngestJob(db, semester.id, user.id);
      expect(j1).not.toBe(j2);
    });
  });
});

// ---------------------------------------------------------------------------
// finalizeIngestJob (phase 9b — full aggregation)
// ---------------------------------------------------------------------------

describe('finalizeIngestJob', () => {
  it('sets status=succeeded on a running job with no files', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db, user.id);
      const { jobId } = await enqueueIngestJob(db, semester.id, user.id);

      // Move to running first (finalize only transitions from running).
      await db
        .update(ingest_jobs)
        .set({ status: 'running', started_at: new Date() })
        .where(eq(ingest_jobs.id, jobId));

      await expect(finalizeIngestJob(db, jobId)).resolves.toBeUndefined();

      const rows = await db.select().from(ingest_jobs).where(eq(ingest_jobs.id, jobId));
      expect(rows[0]!.status).toBe('succeeded');
    });
  });

  it('no-ops gracefully if jobId does not exist', async () => {
    await withTestDb(async (db) => {
      const nonExistent = crypto.randomUUID();
      await expect(finalizeIngestJob(db, nonExistent)).resolves.toBeUndefined();
    });
  });

  it('no-ops gracefully for a cancelled job', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db, user.id);
      const { jobId } = await enqueueIngestJob(db, semester.id, user.id);

      await cancelIngestJob(db, jobId, semester.id);
      // Should not throw even though status is cancelled.
      await expect(finalizeIngestJob(db, jobId)).resolves.toBeUndefined();

      // Status should remain cancelled.
      const rows = await db.select().from(ingest_jobs).where(eq(ingest_jobs.id, jobId));
      expect(rows[0]!.status).toBe('cancelled');
    });
  });
});

// ---------------------------------------------------------------------------
// cancelIngestJob
// ---------------------------------------------------------------------------

describe('cancelIngestJob', () => {
  it('sets status=cancelled on a queued job and returns cancelled:true', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db, user.id);
      const { jobId } = await enqueueIngestJob(db, semester.id, user.id);

      const result = await cancelIngestJob(db, jobId, semester.id);
      expect(result.cancelled).toBe(true);
      expect(result.previous_status).toBe('queued');

      const rows = await db.select().from(ingest_jobs).where(eq(ingest_jobs.id, jobId));
      expect(rows[0]!.status).toBe('cancelled');
      expect(rows[0]!.completed_at).not.toBeNull();
    });
  });

  it('is idempotent — cancelling an already-cancelled job returns cancelled:false', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db, user.id);
      const { jobId } = await enqueueIngestJob(db, semester.id, user.id);

      await cancelIngestJob(db, jobId, semester.id);
      const result = await cancelIngestJob(db, jobId, semester.id);
      expect(result.cancelled).toBe(false);
      expect(result.previous_status).toBe('cancelled');
    });
  });

  it('throws INGEST_JOB_NOT_CANCELLABLE (409) when job is in a terminal state', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db, user.id);
      const { jobId } = await enqueueIngestJob(db, semester.id, user.id);

      // Force-set to 'failed' via failIngestJob (simulates a terminal state).
      await failIngestJob(db, jobId, 'forced failure for test');

      const err = await cancelIngestJob(db, jobId, semester.id).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as { code?: string }).code).toBe('INGEST_JOB_NOT_CANCELLABLE');
    });
  });

  it('throws NOT_FOUND if jobId does not exist in the semester', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db, user.id);
      const nonExistent = crypto.randomUUID();
      await expect(cancelIngestJob(db, nonExistent, semester.id)).rejects.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// failIngestJob
// ---------------------------------------------------------------------------

describe('failIngestJob', () => {
  it('sets status=failed with error detail in summary', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db, user.id);
      const { jobId } = await enqueueIngestJob(db, semester.id, user.id);

      await failIngestJob(db, jobId, 'stageBlob threw on file 2');

      const rows = await db.select().from(ingest_jobs).where(eq(ingest_jobs.id, jobId));
      expect(rows[0]!.status).toBe('failed');
      expect(rows[0]!.completed_at).not.toBeNull();
      expect((rows[0]!.summary as Record<string, string>).error).toBe('stageBlob threw on file 2');
    });
  });

  it('no-ops silently if jobId does not exist', async () => {
    await withTestDb(async (db) => {
      // Should not throw.
      await expect(failIngestJob(db, crypto.randomUUID(), 'irrelevant')).resolves.toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// maybeEnqueueFinalize — staging_complete gate
// ---------------------------------------------------------------------------

/** Insert a terminal (non-pending) ingest_files row so it is NOT counted as pending. */
async function seedTerminalFile(db: DrizzleDb, jobId: string) {
  await db.insert(ingest_files).values({
    id: crypto.randomUUID(),
    ingest_job_id: jobId,
    original_filename: 'f.zip',
    size_bytes: 1,
    blob_sha256: 'a'.repeat(64),
    status: 'matched',
  });
}

/** Insert a pending ingest_files row. */
async function seedPendingFile(db: DrizzleDb, jobId: string) {
  await db.insert(ingest_files).values({
    id: crypto.randomUUID(),
    ingest_job_id: jobId,
    original_filename: 'p.zip',
    size_bytes: 1,
    blob_sha256: 'b'.repeat(64),
    status: 'pending',
  });
}

describe('maybeEnqueueFinalize gate', () => {
  it('does NOT enqueue finalize while staging_complete is false, even with 0 pending', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db, user.id);
      const { jobId } = await enqueueIngestJob(db, semester.id, user.id);
      await markStagingStarted(db, jobId); // staging_complete = false
      await seedTerminalFile(db, jobId); // 0 pending

      const boss = { send: vi.fn() };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await maybeEnqueueFinalize(boss as any, db, jobId);

      expect(boss.send).not.toHaveBeenCalled();
    });
  });

  it('enqueues finalize once staging_complete is true and 0 pending', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db, user.id);
      const { jobId } = await enqueueIngestJob(db, semester.id, user.id);
      await markStagingStarted(db, jobId);
      await seedTerminalFile(db, jobId);
      await markStagingComplete(db, jobId); // staging_complete = true

      const boss = { send: vi.fn() };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await maybeEnqueueFinalize(boss as any, db, jobId);

      expect(boss.send).toHaveBeenCalledTimes(1);
      expect(boss.send).toHaveBeenCalledWith(
        'ingest_finalize',
        { ingestJobId: jobId },
        { singletonKey: jobId, retryLimit: 5 },
      );
    });
  });

  it('does NOT enqueue finalize when files are still pending', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db, user.id);
      const { jobId } = await enqueueIngestJob(db, semester.id, user.id);
      // staging_complete defaults true; but a pending file remains.
      await seedPendingFile(db, jobId);

      const boss = { send: vi.fn() };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await maybeEnqueueFinalize(boss as any, db, jobId);

      expect(boss.send).not.toHaveBeenCalled();
    });
  });

  it('markStagingStarted then markStagingComplete flips staging_complete', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db, user.id);
      const { jobId } = await enqueueIngestJob(db, semester.id, user.id);

      await markStagingStarted(db, jobId);
      let row = (await db.select().from(ingest_jobs).where(eq(ingest_jobs.id, jobId)))[0]!;
      expect(row.staging_complete).toBe(false);

      await markStagingComplete(db, jobId);
      row = (await db.select().from(ingest_jobs).where(eq(ingest_jobs.id, jobId)))[0]!;
      expect(row.staging_complete).toBe(true);
    });
  });
});
