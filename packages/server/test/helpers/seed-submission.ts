/**
 * Shared test helper: seed a minimal submission row (with all required parent
 * rows) and return the submission UUID.
 *
 * Used by materialize-events.test.ts and stats.test.ts. Reuse freely in any
 * integration test that needs a submission row to foreign-key against.
 */

import {
  users,
  courses,
  semesters,
  roster_entries,
  assignments,
  ingest_jobs,
  submissions,
} from '../../src/db/schema.js';
import type { DrizzleDb } from '../../src/db/client.js';

export async function seedSubmission(db: DrizzleDb): Promise<string> {
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
    .values({
      name: 'CS',
      slug: `c-${uid.slice(0, 8)}`,
    })
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
    .values({
      semester_id: semester!.id,
      sid: `s-${uid.slice(0, 6)}`,
      display_name: 'Alice',
    })
    .returning();

  const [assignment] = await db
    .insert(assignments)
    .values({
      semester_id: semester!.id,
      assignment_id_str: 'hw1',
      label: 'HW1',
    })
    .returning();

  const [ingestJob] = await db
    .insert(ingest_jobs)
    .values({
      semester_id: semester!.id,
      uploaded_by: user!.id,
      status: 'running',
    })
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
    ingest_job_id: ingestJob!.id,
    version_index: 1,
  });

  return submissionId;
}
