/**
 * Integration tests for ingest job-control (enqueueIngestJob, finalizeIngestJob, cancelIngestJob).
 *
 * Uses withTestDb — requires Docker.
 */

import { vi, describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { withTestDb } from '../../../test/helpers/db.js';
import {
  enqueueIngestJob,
  finalizeIngestJob,
  cancelIngestJob,
  failIngestJob,
} from './job-control.js';
import { users, courses, semesters, ingest_jobs } from '../../db/schema.js';
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
