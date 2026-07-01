/**
 * Tests for runAndStoreCrossHeuristics (Phase 14).
 *
 * Strategy: boundary tests for the wrapper over v2 cross-heuristics.
 *   1. Synthetic two-bundle paste-shared case: two bundles with a shared paste
 *      content → one cross_flags row + 2 cross_flag_participants.
 *   2. Empty semester (1 submission): returns {flag_count:0, participant_count:0},
 *      no cross_flags rows.
 *   3. Idempotency (DELETE-then-INSERT contract): run twice → same final DB state.
 *   4. Stale flag flush: insert a synthetic cross_flag row, then run cross →
 *      stale row is replaced by the fresh result.
 *
 * Events are no longer persisted in Postgres — runAndStoreCrossHeuristics now
 * reads each submission's event stream by re-parsing its stored bundle blob
 * (via loadSubmissionIndex). To trigger paste_shared_across_students, we build
 * and store real bundle blobs (in a test MinIO) whose sessions carry a 'paste'
 * event with matching sha256/content, instead of inserting into the (removed)
 * events table.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { eq, count } from 'drizzle-orm';
import { withTestDb } from '../../../test/helpers/db.js';
import { withTestMinio } from '../../../test/helpers/minio.js';
import { seedSubmission } from '../../../test/helpers/seed-submission.js';
import { putSubmissionBundle } from '../../../test/helpers/seed-bundle.js';
import { buildTestBundle } from '@provenance/analysis-core/test-support/build-test-bundle.js';
import { runAndStoreCrossHeuristics } from './run-cross.js';
import { _resetBundleIndexCacheForTest } from '../bundle/load-index.js';
import {
  cross_flags,
  cross_flag_participants,
  submissions,
  roster_entries,
  assignments,
} from '../../db/schema.js';
import type { DrizzleDb } from '../../db/client.js';
import type { StorageClient } from '../storage/client.js';

beforeEach(() => {
  _resetBundleIndexCacheForTest();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Seed a minimal submission row + return both submissionId and semesterId. */
async function seedSubmissionWithSemester(
  db: DrizzleDb,
): Promise<{ submissionId: string; semesterId: string }> {
  const submissionId = await seedSubmission(db);
  const [row] = await db
    .select({ semester_id: submissions.semester_id })
    .from(submissions)
    .where(eq(submissions.id, submissionId))
    .limit(1);
  return { submissionId, semesterId: row!.semester_id };
}

/**
 * Insert a second submission into an already-seeded semester (new student +
 * assignment, reusing the first submission's ingest_job_id). Mirrors
 * seedSubmission's shape but targets an existing semester so two submissions
 * can be compared cross-submission.
 */
async function seedSecondSubmissionInSemester(
  db: DrizzleDb,
  opts: {
    semesterId: string;
    sidPrefix: string;
    displayName: string;
    assignmentIdStr: string;
    label: string;
    sourceFilename: string;
    ingestJobId: string;
  },
): Promise<string> {
  const [student] = await db
    .insert(roster_entries)
    .values({
      semester_id: opts.semesterId,
      sid: `${opts.sidPrefix}-${crypto.randomUUID().slice(0, 6)}`,
      display_name: opts.displayName,
    })
    .returning();

  const [assignment] = await db
    .insert(assignments)
    .values({
      semester_id: opts.semesterId,
      assignment_id_str: opts.assignmentIdStr,
      label: opts.label,
    })
    .returning();

  const subId = crypto.randomUUID();
  await db.insert(submissions).values({
    id: subId,
    semester_id: opts.semesterId,
    assignment_id: assignment!.id,
    student_id: student!.id,
    blob_object_key: `semesters/${opts.semesterId}/submissions/${subId}/bundle.zip`,
    blob_sha256: `sha256-${subId}`,
    source_filename: opts.sourceFilename,
    ingest_job_id: opts.ingestJobId,
    version_index: 1,
  });

  return subId;
}

/**
 * Build a single-session bundle whose only post-session.start event is a
 * 'paste' with the given sha256/content, and store it as the submission's blob.
 * length must be >= 100 to satisfy the paste_shared_across_students minLength
 * threshold.
 */
async function putPasteBundle(
  db: DrizzleDb,
  storage: StorageClient,
  submissionId: string,
  opts: { sha256: string; content: string },
): Promise<void> {
  const sessionId = crypto.randomUUID();
  const { zipBuffer } = await buildTestBundle({
    sessions: [
      {
        sessionId,
        events: [
          {
            kind: 'paste',
            data: {
              path: 'main.py',
              sha256: opts.sha256,
              content: opts.content,
              length: opts.content.length,
            },
          },
        ],
      },
    ],
  });
  await putSubmissionBundle(db, storage, submissionId, new Uint8Array(zipBuffer));
}

/** Build + store a bundle with just a session.start (no shared-paste signal). */
async function putEmptyBundle(
  db: DrizzleDb,
  storage: StorageClient,
  submissionId: string,
): Promise<void> {
  const { zipBuffer } = await buildTestBundle({ sessions: [{ eventCount: 0 }] });
  await putSubmissionBundle(db, storage, submissionId, new Uint8Array(zipBuffer));
}

// A paste content long enough (>= 100 chars) for the heuristic to trigger.
const SHARED_PASTE_CONTENT = 'x'.repeat(120);
const SHARED_PASTE_SHA256 = 'abc123deadbeef';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runAndStoreCrossHeuristics', () => {
  it('produces one cross_flags row + 2 participants for two bundles with shared paste', async () => {
    await withTestMinio(async ({ client }) => {
      await withTestDb(async (db) => {
        // Seed two submissions in the same semester.
        const { submissionId: sub1, semesterId } = await seedSubmissionWithSemester(db);

        const [sub1Row] = await db
          .select({ ingest_job_id: submissions.ingest_job_id })
          .from(submissions)
          .where(eq(submissions.id, sub1))
          .limit(1);

        const sub2Id = await seedSecondSubmissionInSemester(db, {
          semesterId,
          sidPrefix: 's2',
          displayName: 'Bob',
          assignmentIdStr: 'hw2',
          label: 'HW2',
          sourceFilename: 'hw2-student2.zip',
          ingestJobId: sub1Row!.ingest_job_id,
        });

        // Store bundle blobs for both submissions with a shared paste sha256.
        await putPasteBundle(db, client, sub1, {
          sha256: SHARED_PASTE_SHA256,
          content: SHARED_PASTE_CONTENT,
        });
        await putPasteBundle(db, client, sub2Id, {
          sha256: SHARED_PASTE_SHA256,
          content: SHARED_PASTE_CONTENT,
        });

        const result = await runAndStoreCrossHeuristics(db, client, semesterId);

        expect(result.flag_count, 'should have 1 cross flag').toBe(1);
        expect(result.participant_count, 'should have 2 participants').toBe(2);

        // Verify DB rows.
        const flagRows = await db
          .select()
          .from(cross_flags)
          .where(eq(cross_flags.semester_id, semesterId));
        expect(flagRows).toHaveLength(1);
        expect(flagRows[0]!.heuristic_id).toBe('paste_shared_across_students');

        const participantRows = await db
          .select()
          .from(cross_flag_participants)
          .where(eq(cross_flag_participants.cross_flag_id, flagRows[0]!.id));
        expect(participantRows).toHaveLength(2);

        const participantSubIds = participantRows.map((p) => p.submission_id).sort();
        expect(participantSubIds).toContain(sub1);
        expect(participantSubIds).toContain(sub2Id);
      });
    });
  });

  it('returns zero flags for semester with only one submission', async () => {
    await withTestMinio(async ({ client }) => {
      await withTestDb(async (db) => {
        const { submissionId, semesterId } = await seedSubmissionWithSemester(db);

        // Seed a bundle so reconstruction would work if it were ever invoked
        // (it isn't — the <2-submission path short-circuits before feature
        // extraction — but this keeps the submission row realistic).
        await putPasteBundle(db, client, submissionId, {
          sha256: SHARED_PASTE_SHA256,
          content: SHARED_PASTE_CONTENT,
        });

        const result = await runAndStoreCrossHeuristics(db, client, semesterId);

        expect(result.flag_count).toBe(0);
        expect(result.participant_count).toBe(0);

        // No cross_flags rows in DB.
        const cntRows = await db
          .select({ cnt: count() })
          .from(cross_flags)
          .where(eq(cross_flags.semester_id, semesterId));
        expect(cntRows[0]?.cnt ?? 0).toBe(0);
      });
    });
  });

  it('is idempotent: running twice produces the same final DB state', async () => {
    await withTestMinio(async ({ client }) => {
      await withTestDb(async (db) => {
        const { submissionId: sub1, semesterId } = await seedSubmissionWithSemester(db);

        const [sub1Row] = await db
          .select({ ingest_job_id: submissions.ingest_job_id })
          .from(submissions)
          .where(eq(submissions.id, sub1))
          .limit(1);

        const sub2Id = await seedSecondSubmissionInSemester(db, {
          semesterId,
          sidPrefix: 's3',
          displayName: 'Charlie',
          assignmentIdStr: 'hw3',
          label: 'HW3',
          sourceFilename: 'hw3-charlie.zip',
          ingestJobId: sub1Row!.ingest_job_id,
        });

        await putPasteBundle(db, client, sub1, {
          sha256: 'idem-sha',
          content: SHARED_PASTE_CONTENT,
        });
        await putPasteBundle(db, client, sub2Id, {
          sha256: 'idem-sha',
          content: SHARED_PASTE_CONTENT,
        });

        // Run twice.
        const result1 = await runAndStoreCrossHeuristics(db, client, semesterId);
        const result2 = await runAndStoreCrossHeuristics(db, client, semesterId);

        // Both runs should produce the same counts.
        expect(result2.flag_count).toBe(result1.flag_count);
        expect(result2.participant_count).toBe(result1.participant_count);

        // DB should have exactly result1.flag_count rows (not doubled).
        const dbCntRows = await db
          .select({ cnt: count() })
          .from(cross_flags)
          .where(eq(cross_flags.semester_id, semesterId));
        expect(dbCntRows[0]?.cnt ?? 0).toBe(result1.flag_count);
      });
    });
  });

  it('flushes obsolete cross_flags from prior runs', async () => {
    await withTestMinio(async ({ client }) => {
      await withTestDb(async (db) => {
        const { submissionId, semesterId } = await seedSubmissionWithSemester(db);

        // Insert a stale cross_flag row directly (simulating a prior run).
        const staleFlagId = crypto.randomUUID();
        await db.insert(cross_flags).values({
          id: staleFlagId,
          semester_id: semesterId,
          heuristic_id: 'paste_shared_across_students',
          severity: 'high',
          confidence: 0.95,
          detail: {} as unknown as Record<string, unknown>,
          heuristic_config_version: 0,
        });

        // Verify the stale flag exists.
        const beforeRows = await db
          .select({ cnt: count() })
          .from(cross_flags)
          .where(eq(cross_flags.semester_id, semesterId));
        expect(beforeRows[0]?.cnt ?? 0).toBe(1);

        // Seed just one submission (no cross-submission match possible).
        await putEmptyBundle(db, client, submissionId);

        // Run cross-heuristics with only 1 submission → should DELETE the stale flag.
        const result = await runAndStoreCrossHeuristics(db, client, semesterId);

        expect(result.flag_count).toBe(0);

        // Stale flag should be gone.
        const afterRows = await db
          .select({ cnt: count() })
          .from(cross_flags)
          .where(eq(cross_flags.semester_id, semesterId));
        expect(afterRows[0]?.cnt ?? 0).toBe(0);
      });
    });
  });
});
