/**
 * Integration tests for createSubmission (PRD §9.3 phase 5).
 *
 * Uses withTestDb (Postgres) + withTestMinio (blob storage).
 */

import { vi, describe, it, expect } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { withTestDb } from '../../../test/helpers/db.js';
import { withTestMinio } from '../../../test/helpers/minio.js';
import { createSubmission } from './create-submission.js';
import { putBlob, getBlob } from '../storage/blobs.js';
import { ingestStagingKey, bundleKey } from '../storage/keys.js';
import {
  users,
  courses,
  semesters,
  roster_entries,
  assignments,
  ingest_jobs,
  submissions,
} from '../../db/schema.js';
import type { DrizzleDb } from '../../db/client.js';
import type { StorageClient } from '../storage/client.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

async function seedUser(db: DrizzleDb) {
  const id = crypto.randomUUID();
  const [user] = await db
    .insert(users)
    .values({ id, google_subject: `sub-${id}`, email: `u-${id}@berkeley.edu`, display_name: 'U' })
    .returning();
  return user!;
}

async function seedSemester(db: DrizzleDb) {
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

async function seedStudent(db: DrizzleDb, semesterId: string, sid = '123456') {
  const [entry] = await db
    .insert(roster_entries)
    .values({ semester_id: semesterId, sid, display_name: 'Student' })
    .returning();
  return entry!;
}

async function seedIngestJob(db: DrizzleDb, semesterId: string, userId: string) {
  const [job] = await db
    .insert(ingest_jobs)
    .values({ semester_id: semesterId, uploaded_by: userId, status: 'running', summary: {} })
    .returning();
  return job!;
}

async function stageTestBlob(
  client: StorageClient,
  jobId: string,
  fileId: string,
  content: Uint8Array,
): Promise<string> {
  const key = ingestStagingKey(jobId, fileId);
  await putBlob(client, key, content);
  return key;
}

async function collectStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createSubmission', () => {
  it('inserts a submission row with version_index=1 for a new student-assignment', async () => {
    await withTestDb(async (db) => {
      await withTestMinio(async ({ client }) => {
        const user = await seedUser(db);
        const semester = await seedSemester(db);
        const student = await seedStudent(db, semester.id);
        const job = await seedIngestJob(db, semester.id, user.id);

        const fileId = crypto.randomUUID();
        const content = new TextEncoder().encode('test bundle content');
        const stagingKey = await stageTestBlob(client, job.id, fileId, content);

        const result = await createSubmission(
          { db, storageClient: client },
          {
            semesterId: semester.id,
            assignmentIdStr: 'hw01',
            studentId: student.id,
            blobSha256: 'a'.repeat(64),
            stagingKey,
            originalFilename: 'hw01-123456.zip',
            ingestJobId: job.id,
          },
        );

        expect(result.versionIndex).toBe(1);
        expect(result.supersededIds).toHaveLength(0);

        const rows = await db
          .select()
          .from(submissions)
          .where(eq(submissions.id, result.submissionId));
        expect(rows).toHaveLength(1);
        expect(rows[0]!.version_index).toBe(1);
        expect(rows[0]!.assignment_id).toBeTruthy();
      });
    });
  });

  it('allocates version_index=2 for a re-upload by the same student', async () => {
    await withTestDb(async (db) => {
      await withTestMinio(async ({ client }) => {
        const user = await seedUser(db);
        const semester = await seedSemester(db);
        const student = await seedStudent(db, semester.id);
        const job = await seedIngestJob(db, semester.id, user.id);

        // First upload.
        const fileId1 = crypto.randomUUID();
        const content1 = new TextEncoder().encode('version 1');
        const stagingKey1 = await stageTestBlob(client, job.id, fileId1, content1);

        const result1 = await createSubmission(
          { db, storageClient: client },
          {
            semesterId: semester.id,
            assignmentIdStr: 'hw01',
            studentId: student.id,
            blobSha256: 'b'.repeat(64),
            stagingKey: stagingKey1,
            originalFilename: 'hw01-123456.zip',
            ingestJobId: job.id,
          },
        );
        expect(result1.versionIndex).toBe(1);

        // Second upload (re-upload).
        const fileId2 = crypto.randomUUID();
        const content2 = new TextEncoder().encode('version 2');
        const stagingKey2 = await stageTestBlob(client, job.id, fileId2, content2);

        const result2 = await createSubmission(
          { db, storageClient: client },
          {
            semesterId: semester.id,
            assignmentIdStr: 'hw01',
            studentId: student.id,
            blobSha256: 'c'.repeat(64),
            stagingKey: stagingKey2,
            originalFilename: 'hw01-123456.zip',
            ingestJobId: job.id,
          },
        );
        expect(result2.versionIndex).toBe(2);
        expect(result2.supersededIds).toContain(result1.submissionId);
      });
    });
  });

  it('sets superseded_by_submission_id on prior versions after a re-upload', async () => {
    await withTestDb(async (db) => {
      await withTestMinio(async ({ client }) => {
        const user = await seedUser(db);
        const semester = await seedSemester(db);
        const student = await seedStudent(db, semester.id);
        const job = await seedIngestJob(db, semester.id, user.id);

        const fileId1 = crypto.randomUUID();
        const stagingKey1 = await stageTestBlob(
          client,
          job.id,
          fileId1,
          new TextEncoder().encode('v1'),
        );
        const result1 = await createSubmission(
          { db, storageClient: client },
          {
            semesterId: semester.id,
            assignmentIdStr: 'hw02',
            studentId: student.id,
            blobSha256: 'd'.repeat(64),
            stagingKey: stagingKey1,
            originalFilename: 'hw02-123456.zip',
            ingestJobId: job.id,
          },
        );

        const fileId2 = crypto.randomUUID();
        const stagingKey2 = await stageTestBlob(
          client,
          job.id,
          fileId2,
          new TextEncoder().encode('v2'),
        );
        const result2 = await createSubmission(
          { db, storageClient: client },
          {
            semesterId: semester.id,
            assignmentIdStr: 'hw02',
            studentId: student.id,
            blobSha256: 'e'.repeat(64),
            stagingKey: stagingKey2,
            originalFilename: 'hw02-123456.zip',
            ingestJobId: job.id,
          },
        );

        // Verify DB: v1 should have superseded_by_submission_id = v2.id
        const [v1Row] = await db
          .select({ superseded_by: submissions.superseded_by_submission_id })
          .from(submissions)
          .where(eq(submissions.id, result1.submissionId));
        expect(v1Row!.superseded_by).toBe(result2.submissionId);
      });
    });
  });

  it('moves blob from staging to final key, staging key no longer accessible', async () => {
    await withTestDb(async (db) => {
      await withTestMinio(async ({ client }) => {
        const user = await seedUser(db);
        const semester = await seedSemester(db);
        const student = await seedStudent(db, semester.id);
        const job = await seedIngestJob(db, semester.id, user.id);

        const fileId = crypto.randomUUID();
        const content = new TextEncoder().encode('bundle bytes for move test');
        const stagingKey = await stageTestBlob(client, job.id, fileId, content);

        const result = await createSubmission(
          { db, storageClient: client },
          {
            semesterId: semester.id,
            assignmentIdStr: 'hw01',
            studentId: student.id,
            blobSha256: 'f'.repeat(64),
            stagingKey,
            originalFilename: 'hw01-123456.zip',
            ingestJobId: job.id,
          },
        );

        // Final blob should be readable.
        const finalKey = bundleKey(semester.id, result.submissionId);
        const finalStream = await getBlob(client, finalKey);
        const finalBytes = await collectStream(finalStream);
        expect(finalBytes).toEqual(content);

        // Staging key should no longer be readable.
        await expect(getBlob(client, stagingKey)).rejects.toThrow();
      });
    });
  });

  it('upserts the assignments row and reuses it on subsequent uploads', async () => {
    await withTestDb(async (db) => {
      await withTestMinio(async ({ client }) => {
        const user = await seedUser(db);
        const semester = await seedSemester(db);
        const student1 = await seedStudent(db, semester.id, '111111');
        const student2 = await seedStudent(db, semester.id, '222222');
        const job = await seedIngestJob(db, semester.id, user.id);

        const fileId1 = crypto.randomUUID();
        const stagingKey1 = await stageTestBlob(
          client,
          job.id,
          fileId1,
          new TextEncoder().encode('s1'),
        );
        const result1 = await createSubmission(
          { db, storageClient: client },
          {
            semesterId: semester.id,
            assignmentIdStr: 'hw03',
            studentId: student1.id,
            blobSha256: '1'.repeat(64),
            stagingKey: stagingKey1,
            originalFilename: 'hw03-111111.zip',
            ingestJobId: job.id,
          },
        );

        const fileId2 = crypto.randomUUID();
        const stagingKey2 = await stageTestBlob(
          client,
          job.id,
          fileId2,
          new TextEncoder().encode('s2'),
        );
        const result2 = await createSubmission(
          { db, storageClient: client },
          {
            semesterId: semester.id,
            assignmentIdStr: 'hw03', // same assignment
            studentId: student2.id,
            blobSha256: '2'.repeat(64),
            stagingKey: stagingKey2,
            originalFilename: 'hw03-222222.zip',
            ingestJobId: job.id,
          },
        );

        // Both submissions reference the same assignment row.
        const [sub1] = await db
          .select({ assignment_id: submissions.assignment_id })
          .from(submissions)
          .where(eq(submissions.id, result1.submissionId));
        const [sub2] = await db
          .select({ assignment_id: submissions.assignment_id })
          .from(submissions)
          .where(eq(submissions.id, result2.submissionId));
        expect(sub1!.assignment_id).toBe(sub2!.assignment_id);

        // Only one assignment row for hw03 in this semester.
        const aRows = await db
          .select()
          .from(assignments)
          .where(
            and(eq(assignments.semester_id, semester.id), eq(assignments.assignment_id_str, 'hw03')),
          );
        expect(aRows).toHaveLength(1);
      });
    });
  });

  it('stores recorder_version and format_version from manifest', async () => {
    await withTestDb(async (db) => {
      await withTestMinio(async ({ client }) => {
        const user = await seedUser(db);
        const semester = await seedSemester(db);
        const student = await seedStudent(db, semester.id);
        const job = await seedIngestJob(db, semester.id, user.id);

        const fileId = crypto.randomUUID();
        const stagingKey = await stageTestBlob(
          client,
          job.id,
          fileId,
          new TextEncoder().encode('v'),
        );

        const result = await createSubmission(
          { db, storageClient: client },
          {
            semesterId: semester.id,
            assignmentIdStr: 'hw01',
            studentId: student.id,
            blobSha256: 'a'.repeat(64),
            stagingKey,
            originalFilename: 'hw01-123456.zip',
            ingestJobId: job.id,
            recorderVersion: '1.2.3',
            formatVersion: '1.0',
          },
        );

        const [row] = await db
          .select({ recorder_version: submissions.recorder_version, format_version: submissions.format_version })
          .from(submissions)
          .where(eq(submissions.id, result.submissionId));
        expect(row!.recorder_version).toBe('1.2.3');
        expect(row!.format_version).toBe('1.0');
      });
    });
  });
});
