/**
 * Integration tests for the dedup phase (PRD §9.3 phase 2).
 *
 * Uses withTestDb — requires Docker.
 */

import { vi, describe, it, expect } from 'vitest';

import { withTestDb } from '../../../test/helpers/db.js';
import { dedupFile } from './dedup.js';
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

async function seedRosterEntry(db: DrizzleDb, semesterId: string, sid = '123456') {
  const [entry] = await db
    .insert(roster_entries)
    .values({ semester_id: semesterId, sid, display_name: 'Test Student' })
    .returning();
  return entry!;
}

async function seedAssignment(db: DrizzleDb, semesterId: string, assignmentIdStr = 'hw01') {
  const [assignment] = await db
    .insert(assignments)
    .values({ semester_id: semesterId, assignment_id_str: assignmentIdStr })
    .returning();
  return assignment!;
}

async function seedIngestJob(db: DrizzleDb, semesterId: string, userId: string) {
  const [job] = await db
    .insert(ingest_jobs)
    .values({ semester_id: semesterId, uploaded_by: userId, status: 'running', summary: {} })
    .returning();
  return job!;
}

async function seedSubmission(
  db: DrizzleDb,
  semesterId: string,
  assignmentId: string,
  studentId: string,
  ingestJobId: string,
  blobSha256: string,
  versionIndex = 1,
) {
  const [sub] = await db
    .insert(submissions)
    .values({
      semester_id: semesterId,
      assignment_id: assignmentId,
      student_id: studentId,
      blob_object_key: `semesters/${semesterId}/submissions/${crypto.randomUUID()}/bundle.zip`,
      blob_sha256: blobSha256,
      source_filename: 'hw01-123456.zip',
      ingest_job_id: ingestJobId,
      version_index: versionIndex,
    })
    .returning();
  return sub!;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dedupFile', () => {
  it('returns isDuplicate:false when no matching submission exists', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db, user.id);

      const result = await dedupFile(db, semester.id, 'a'.repeat(64));
      expect(result.isDuplicate).toBe(false);
    });
  });

  it('returns isDuplicate:true with existingSubmissionId when sha256 matches', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db, user.id);
      const student = await seedRosterEntry(db, semester.id);
      const assignment = await seedAssignment(db, semester.id);
      const job = await seedIngestJob(db, semester.id, user.id);

      const sha256 = 'b'.repeat(64);
      const sub = await seedSubmission(db, semester.id, assignment.id, student.id, job.id, sha256);

      const result = await dedupFile(db, semester.id, sha256);
      expect(result.isDuplicate).toBe(true);
      if (!result.isDuplicate) return;
      expect(result.existingSubmissionId).toBe(sub.id);
    });
  });

  it('does not match a sha256 from a different semester', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester1 = await seedSemester(db, user.id);
      const semester2 = await seedSemester(db, user.id);
      const student = await seedRosterEntry(db, semester1.id);
      const assignment = await seedAssignment(db, semester1.id);
      const job = await seedIngestJob(db, semester1.id, user.id);

      const sha256 = 'c'.repeat(64);
      await seedSubmission(db, semester1.id, assignment.id, student.id, job.id, sha256);

      // Same sha256 but queried against semester2 — should not match.
      const result = await dedupFile(db, semester2.id, sha256);
      expect(result.isDuplicate).toBe(false);
    });
  });

  it('returns isDuplicate:true even for superseded submissions (same sha256)', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db, user.id);
      const student = await seedRosterEntry(db, semester.id);
      const assignment = await seedAssignment(db, semester.id);
      const job = await seedIngestJob(db, semester.id, user.id);

      const sha256 = 'd'.repeat(64);
      // Seed as version 1; it will be "superseded" by a later upload in real code,
      // but the blob sha256 is still unique.
      const sub = await seedSubmission(db, semester.id, assignment.id, student.id, job.id, sha256);

      const result = await dedupFile(db, semester.id, sha256);
      expect(result.isDuplicate).toBe(true);
      if (!result.isDuplicate) return;
      expect(result.existingSubmissionId).toBe(sub.id);
    });
  });

  it('does not match a sha256 that differs by even one character', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db, user.id);
      const student = await seedRosterEntry(db, semester.id);
      const assignment = await seedAssignment(db, semester.id);
      const job = await seedIngestJob(db, semester.id, user.id);

      const sha256Stored = 'e'.repeat(64);
      await seedSubmission(db, semester.id, assignment.id, student.id, job.id, sha256Stored);

      const sha256Query = 'f'.repeat(64); // differs from stored
      const result = await dedupFile(db, semester.id, sha256Query);
      expect(result.isDuplicate).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Student-scoped dedup (Gradescope group submissions)
  // -------------------------------------------------------------------------

  it('with studentId: matches only the same student (co-submitter blob is NOT a duplicate)', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db, user.id);
      const studentA = await seedRosterEntry(db, semester.id, '111111');
      const studentB = await seedRosterEntry(db, semester.id, '222222');
      const assignment = await seedAssignment(db, semester.id);
      const job = await seedIngestJob(db, semester.id, user.id);

      // One group bundle: identical blob bytes ingested for student A.
      const sha256 = 'a1'.repeat(32);
      await seedSubmission(db, semester.id, assignment.id, studentA.id, job.id, sha256);

      // Student B (co-submitter, same blob) must NOT be seen as a duplicate.
      const forB = await dedupFile(db, semester.id, sha256, studentB.id);
      expect(forB.isDuplicate).toBe(false);

      // Student A re-uploading the same blob IS a duplicate (their own resubmit).
      const forA = await dedupFile(db, semester.id, sha256, studentA.id);
      expect(forA.isDuplicate).toBe(true);
    });
  });

  it('with studentId: blob-only callers still see the existing submission as a duplicate', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db, user.id);
      const studentA = await seedRosterEntry(db, semester.id, '111111');
      const assignment = await seedAssignment(db, semester.id);
      const job = await seedIngestJob(db, semester.id, user.id);

      const sha256 = 'b2'.repeat(32);
      const sub = await seedSubmission(db, semester.id, assignment.id, studentA.id, job.id, sha256);

      // No studentId (normal /ingest path) — blob-only dedup still fires.
      const result = await dedupFile(db, semester.id, sha256);
      expect(result.isDuplicate).toBe(true);
      if (!result.isDuplicate) return;
      expect(result.existingSubmissionId).toBe(sub.id);
    });
  });
});
