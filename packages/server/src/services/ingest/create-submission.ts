/**
 * Phase 5 of the per-file ingest pipeline: create submission (PRD §9.3).
 *
 * Responsibilities:
 *   1. Upsert the `assignments` row for (semester, assignment_id_str).
 *   2. Allocate `version_index` = max existing + 1 for this (semester,
 *      assignment, student) tuple, using a row lock (`FOR UPDATE`) to prevent
 *      races when multiple workers process concurrent uploads for the same
 *      student-assignment.
 *   3. Move the blob from `ingest-staging/{jobId}/{fileId}` to
 *      `semesters/{semesterId}/submissions/{submissionId}/bundle.zip`.
 *   4. Insert the `submissions` row.
 *   5. Update `superseded_by_submission_id` on all older versions for this
 *      (semester, assignment, student) tuple to point to the new row.
 *
 * The blob move is: putBlob(final key) then deleteBlob(staging key).
 * If deleteBlob fails, the staging key becomes an orphan for the retention
 * sweep — the submission row already exists so the pipeline is not broken.
 *
 * PRD §9.4: version_index allocation uses `FOR UPDATE` on existing rows
 * for this (semester_id, assignment_id, student_id) cohort to prevent
 * concurrent allocation of the same index.
 */

import { sql } from 'drizzle-orm';
import { assignments, submissions } from '../../db/schema.js';
import type { DrizzleDb } from '../../db/client.js';
import { putBlob, deleteBlob, getBlob } from '../storage/blobs.js';
import { bundleKey } from '../storage/keys.js';
import type { StorageClient } from '../storage/client.js';
import { Errors } from '../../api/v1/errors.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreateSubmissionDeps {
  db: DrizzleDb;
  storageClient: StorageClient;
}

export interface CreateSubmissionArgs {
  semesterId: string;
  assignmentIdStr: string;
  studentId: string;
  blobSha256: string;
  stagingKey: string;
  originalFilename: string;
  ingestJobId: string;
  /** Metadata parsed from the bundle manifest (recorder + format version). */
  recorderVersion?: string;
  formatVersion?: string;
}

export interface CreateSubmissionResult {
  submissionId: string;
  versionIndex: number;
  finalBlobKey: string;
  /** IDs of submissions that were superseded by this one. */
  supersededIds: string[];
}

// ---------------------------------------------------------------------------
// createSubmission
// ---------------------------------------------------------------------------

/**
 * Runs phase 5 of the ingest pipeline for a single file.
 *
 * Must be called inside a database transaction for correctness: the
 * version_index lock (`FOR UPDATE`) and the submissions insert must be atomic.
 *
 * Blob operations (getBlob, putBlob, deleteBlob) happen between the lock
 * acquisition and the insert. If a blob op fails, the transaction is rolled
 * back (no DB row created) and the staging blob is left as an orphan.
 */
export async function createSubmission(
  deps: CreateSubmissionDeps,
  args: CreateSubmissionArgs,
): Promise<CreateSubmissionResult> {
  const { db, storageClient } = deps;
  const {
    semesterId,
    assignmentIdStr,
    studentId,
    blobSha256,
    stagingKey,
    originalFilename,
    ingestJobId,
    recorderVersion = '',
    formatVersion = '',
  } = args;

  return db.transaction(async (tx) => {
    // -----------------------------------------------------------------------
    // Step 1: Upsert assignment row.
    // -----------------------------------------------------------------------
    const [assignmentRow] = await tx
      .insert(assignments)
      .values({
        semester_id: semesterId,
        assignment_id_str: assignmentIdStr,
        label: assignmentIdStr,
      })
      .onConflictDoUpdate({
        target: [assignments.semester_id, assignments.assignment_id_str],
        // On conflict just return the existing row — label is not updated.
        set: { assignment_id_str: assignmentIdStr },
      })
      .returning({ id: assignments.id });

    if (!assignmentRow) {
      throw Errors.internal(undefined, 'createSubmission: assignment upsert returned no rows');
    }

    const assignmentId = assignmentRow.id;

    // -----------------------------------------------------------------------
    // Step 2: Lock existing submissions for this cohort and compute max version.
    //
    // PRD §9.4: use FOR UPDATE on the existing rows to prevent concurrent
    // workers from allocating the same version_index.
    //
    // Drizzle does not have a typed .forUpdate() on select, so we use
    // db.execute(sql`...`) to issue the raw FOR UPDATE query.
    // -----------------------------------------------------------------------
    const lockResult = await tx.execute(sql`
      SELECT id, version_index
      FROM submissions
      WHERE semester_id = ${semesterId}
        AND assignment_id = ${assignmentId}
        AND student_id = ${studentId}
      FOR UPDATE
    `);

    // `lockResult` is an array of rows (postgres.js returns Row[]).
    // Extract max version_index; default to 0 so first submission gets index 1.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- FFI: postgres.js raw result
    const existingRows = (lockResult as any) as Array<{ id: string; version_index: number }>;
    const maxVersion = existingRows.reduce((m, r) => Math.max(m, r.version_index), 0);
    const versionIndex = maxVersion + 1;

    // -----------------------------------------------------------------------
    // Step 3: Allocate the new submission id so we can build the final blob key.
    // -----------------------------------------------------------------------
    const submissionId = crypto.randomUUID();
    const finalBlobKey = bundleKey(semesterId, submissionId);

    // -----------------------------------------------------------------------
    // Step 4: Move blob — read from staging, write to final key.
    //
    // We do this inside the transaction so if it fails the DB row is never
    // inserted. The staging blob is left as an orphan for the retention sweep
    // if deleteBlob fails (non-fatal).
    // -----------------------------------------------------------------------
    let blobStream: ReadableStream<Uint8Array>;
    try {
      blobStream = await getBlob(storageClient, stagingKey);
    } catch (err) {
      throw Errors.internal(
        undefined,
        `createSubmission: getBlob(stagingKey) failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Buffer the stream before the PUT so we don't hold a streaming connection
    // open during the DB insert.
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    const reader = blobStream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      totalBytes += value.byteLength;
    }
    const combined = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }

    try {
      await putBlob(storageClient, finalBlobKey, combined);
    } catch (err) {
      throw Errors.internal(
        undefined,
        `createSubmission: putBlob(finalKey) failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // -----------------------------------------------------------------------
    // Step 5: Insert the submissions row.
    // -----------------------------------------------------------------------
    await tx.insert(submissions).values({
      id: submissionId,
      semester_id: semesterId,
      assignment_id: assignmentId,
      student_id: studentId,
      blob_object_key: finalBlobKey,
      blob_sha256: blobSha256,
      recorder_version: recorderVersion,
      format_version: formatVersion,
      source_filename: originalFilename,
      ingest_job_id: ingestJobId,
      version_index: versionIndex,
    });

    // -----------------------------------------------------------------------
    // Step 6: Update superseded_by_submission_id on all prior versions.
    //
    // Drizzle's schema omits the self-referential FK for superseded_by, so we
    // use raw SQL here (per CLAUDE.md: use db.execute(sql`...`) for omitted FKs).
    // -----------------------------------------------------------------------
    const supersededIds: string[] = existingRows.map((r) => r.id);

    if (supersededIds.length > 0) {
      await tx.execute(sql`
        UPDATE submissions
        SET superseded_by_submission_id = ${submissionId}
        WHERE id = ANY(${sql.raw(`ARRAY[${supersededIds.map((id) => `'${id}'`).join(',')}]::uuid[]`)})
      `);
    }

    // -----------------------------------------------------------------------
    // Step 7: Delete the staging blob (best-effort; non-fatal on failure).
    // -----------------------------------------------------------------------
    try {
      await deleteBlob(storageClient, stagingKey);
    } catch {
      // Non-fatal — the submission row is already committed (or will be on
      // transaction commit). The staging blob becomes an orphan for the
      // retention sweep. Logging intentionally omitted here so this function
      // remains dependency-free from the logging singleton (which requires
      // config). The worker layer logs this if needed.
    }

    return {
      submissionId,
      versionIndex,
      finalBlobKey,
      supersededIds,
    };
  });
}
