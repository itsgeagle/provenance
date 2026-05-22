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
 * To trigger paste_shared_across_students, we need two submissions each with a
 * 'paste' event carrying the same sha256 and length >= 100. We inject synthetic
 * events directly into the events table (same approach as materialize-events
 * tests), bypassing the full ingest pipeline for speed.
 */

import { vi, describe, it, expect, beforeAll } from 'vitest';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { eq, count } from 'drizzle-orm';
import { withTestDb } from '../../../test/helpers/db.js';
import { seedSubmission } from '../../../test/helpers/seed-submission.js';
import { runAndStoreCrossHeuristics } from './run-cross.js';
import { cross_flags, cross_flag_participants, events, submissions } from '../../db/schema.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

beforeAll(() => {
  ed.hashes.sha512 = sha512;
  (ed.hashes as Record<string, unknown>)['sha512Async'] = (m: Uint8Array) =>
    Promise.resolve(sha512(m));
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Seed a minimal submission row + return both submissionId and semesterId. */
async function seedSubmissionWithSemester(
  db: Parameters<typeof seedSubmission>[0],
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
 * Seed a session.start + one paste event for a submission.
 *
 * The paste event has kind='paste', payload={length, sha256, content}.
 * length must be >= 100 to satisfy the paste_shared_across_students minLength threshold.
 */
async function seedPasteEvents(
  db: Parameters<typeof seedSubmission>[0],
  submissionId: string,
  opts: { seqOffset?: number; sha256: string; content: string },
) {
  const sessionId = crypto.randomUUID();
  const wallBase = Date.now();
  const seqOffset = opts.seqOffset ?? 0;

  await db.insert(events).values([
    {
      submission_id: submissionId,
      seq: seqOffset,
      session_id: sessionId,
      t: 0,
      wall: new Date(wallBase),
      kind: 'session.start',
      payload: { active_file: null } as unknown as Record<string, unknown>,
      prev_hash: 'GENESIS',
      hash: `h-${sessionId}-0`,
    },
    {
      submission_id: submissionId,
      seq: seqOffset + 1,
      session_id: sessionId,
      t: 100,
      wall: new Date(wallBase + 1000),
      kind: 'paste',
      payload: {
        length: opts.content.length,
        sha256: opts.sha256,
        content: opts.content,
      } as unknown as Record<string, unknown>,
      prev_hash: `h-${sessionId}-0`,
      hash: `h-${sessionId}-1`,
    },
  ]);

  return { sessionId };
}

// A paste content long enough (>= 100 chars) for the heuristic to trigger.
const SHARED_PASTE_CONTENT = 'x'.repeat(120);
const SHARED_PASTE_SHA256 = 'abc123deadbeef';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runAndStoreCrossHeuristics', () => {
  it('produces one cross_flags row + 2 participants for two bundles with shared paste', async () => {
    await withTestDb(async (db) => {
      // Seed two submissions in the same semester.
      const { submissionId: sub1, semesterId } = await seedSubmissionWithSemester(db);

      // We need a second submission in the same semester with the same student and assignment
      // won't work with the seed helper directly. Instead, let's seed a second full set
      // but inject into the same semester by using a custom seed.
      // Actually, seedSubmission creates a new semester per call. We need them in the SAME semester.
      // Let's do it manually.

      // Insert second submission into the same semester (requires same assignment/student).
      // For simplicity, create a new student+assignment in the same semester.
      const { roster_entries, assignments } = await import('../../db/schema.js');

      const [student2] = await db
        .insert(roster_entries)
        .values({
          semester_id: semesterId,
          sid: `s2-${crypto.randomUUID().slice(0, 6)}`,
          display_name: 'Bob',
        })
        .returning();

      const [assignment2] = await db
        .insert(assignments)
        .values({
          semester_id: semesterId,
          assignment_id_str: 'hw2',
          label: 'HW2',
        })
        .returning();

      // Look up the ingest_job for sub1 to reuse it as the ingest_job_id for sub2.
      const [sub1Row] = await db
        .select({ ingest_job_id: submissions.ingest_job_id })
        .from(submissions)
        .where(eq(submissions.id, sub1))
        .limit(1);

      const sub2Id = crypto.randomUUID();
      await db.insert(submissions).values({
        id: sub2Id,
        semester_id: semesterId,
        assignment_id: assignment2!.id,
        student_id: student2!.id,
        blob_object_key: `semesters/${semesterId}/submissions/${sub2Id}/bundle.zip`,
        blob_sha256: `sha256-${sub2Id}`,
        source_filename: 'hw2-student2.zip',
        ingest_job_id: sub1Row!.ingest_job_id,
        version_index: 1,
      });

      // Seed paste events for both submissions with the same sha256.
      await seedPasteEvents(db, sub1, { sha256: SHARED_PASTE_SHA256, content: SHARED_PASTE_CONTENT });
      await seedPasteEvents(db, sub2Id, {
        sha256: SHARED_PASTE_SHA256,
        content: SHARED_PASTE_CONTENT,
      });

      const result = await runAndStoreCrossHeuristics(db, semesterId);

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

  it('returns zero flags for semester with only one submission', async () => {
    await withTestDb(async (db) => {
      const { submissionId, semesterId } = await seedSubmissionWithSemester(db);

      // Seed some events so reconstruction works.
      await seedPasteEvents(db, submissionId, {
        sha256: SHARED_PASTE_SHA256,
        content: SHARED_PASTE_CONTENT,
      });

      const result = await runAndStoreCrossHeuristics(db, semesterId);

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

  it('is idempotent: running twice produces the same final DB state', async () => {
    await withTestDb(async (db) => {
      const { submissionId: sub1, semesterId } = await seedSubmissionWithSemester(db);

      const { roster_entries, assignments } = await import('../../db/schema.js');

      const [student2] = await db
        .insert(roster_entries)
        .values({
          semester_id: semesterId,
          sid: `s3-${crypto.randomUUID().slice(0, 6)}`,
          display_name: 'Charlie',
        })
        .returning();

      const [assignment3] = await db
        .insert(assignments)
        .values({
          semester_id: semesterId,
          assignment_id_str: 'hw3',
          label: 'HW3',
        })
        .returning();

      const [sub1Row] = await db
        .select({ ingest_job_id: submissions.ingest_job_id })
        .from(submissions)
        .where(eq(submissions.id, sub1))
        .limit(1);

      const sub2Id = crypto.randomUUID();
      await db.insert(submissions).values({
        id: sub2Id,
        semester_id: semesterId,
        assignment_id: assignment3!.id,
        student_id: student2!.id,
        blob_object_key: `semesters/${semesterId}/submissions/${sub2Id}/bundle.zip`,
        blob_sha256: `sha256-${sub2Id}`,
        source_filename: 'hw3-charlie.zip',
        ingest_job_id: sub1Row!.ingest_job_id,
        version_index: 1,
      });

      await seedPasteEvents(db, sub1, { sha256: 'idem-sha', content: SHARED_PASTE_CONTENT });
      await seedPasteEvents(db, sub2Id, { sha256: 'idem-sha', content: SHARED_PASTE_CONTENT });

      // Run twice.
      const result1 = await runAndStoreCrossHeuristics(db, semesterId);
      const result2 = await runAndStoreCrossHeuristics(db, semesterId);

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

  it('flushes obsolete cross_flags from prior runs', async () => {
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
      const sessionId = crypto.randomUUID();
      await db.insert(events).values({
        submission_id: submissionId,
        seq: 0,
        session_id: sessionId,
        t: 0,
        wall: new Date(),
        kind: 'session.start',
        payload: { active_file: null } as unknown as Record<string, unknown>,
        prev_hash: 'GENESIS',
        hash: 'h-0',
      });

      // Run cross-heuristics with only 1 submission → should DELETE the stale flag.
      const result = await runAndStoreCrossHeuristics(db, semesterId);

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
