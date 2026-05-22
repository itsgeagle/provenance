/**
 * Background job worker entry point.
 *
 * This module is invoked when the server starts in `--mode=worker` or
 * `--mode=all`. It connects to pg-boss and registers handlers for each
 * job kind.
 *
 * Handler registration is phase-gated:
 *   Phase 9a: pg-boss is started, no handlers registered yet.
 *   Phase 9b: ingest_file + ingest_finalize handlers registered.
 *   Phase 10+: remaining handlers added as phases land.
 *
 * PRD §12: pg-boss owns queue delivery; domain tables own domain state.
 *
 * ## Finalize dispatch strategy (Phase 9b)
 *
 * We use the "last-worker-enqueues-finalize" pattern rather than a fixed
 * delay or a separate scheduler:
 *
 *   After each `ingest_file` job completes (success OR terminal failure):
 *   - Check the count of `ingest_files` rows still in 'pending' status for
 *     the parent job.
 *   - If the count is 0 (all files processed), send one `ingest_finalize`
 *     job with `singletonKey = ingestJobId` so duplicate sends collapse.
 *
 * Rationale: pg-boss `singletonKey` guarantees at most one queued+running
 * instance of `ingest_finalize` per job id. Multiple workers that reach
 * "I am last" simultaneously will each try to enqueue, but only one will
 * actually queue — the others silently no-op. This is correct and race-safe.
 *
 * This avoids the complexity of a time-window approach (singletonSeconds)
 * and does not require an external scheduler or the route handler to
 * orchestrate the finalize dispatch.
 */

import { eq, and, count } from 'drizzle-orm';
import { getBoss, stopBoss, JOB_KINDS } from './pg-boss.js';
import { getLogger } from '../logging.js';
import { getDb } from '../db/client.js';
import { getConfig } from '../config/index.js';
import { ingest_files, ingest_jobs, semesters } from '../db/schema.js';
import { createStorageClient, storageConfigFromEnv } from '../services/storage/client.js';
import { ingestStagingKey } from '../services/storage/keys.js';
import {
  finalizeIngestJob,
  markIngestJobRunning,
  failIngestJob,
} from '../services/ingest/job-control.js';
import { dedupFile } from '../services/ingest/dedup.js';
import { parseBundlePhase } from '../services/ingest/parse-bundle-phase.js';
import { matchStudent } from '../services/ingest/match-student.js';
import { createSubmission } from '../services/ingest/create-submission.js';
import { materializeEvents } from '../services/ingest/materialize-events.js';
import { computeAndStoreStats } from '../services/ingest/stats.js';
import { runAndStoreValidation } from '../services/ingest/validation.js';
import { runAndStoreHeuristics } from '../services/heuristics/run-per-submission.js';
import { withTransaction } from '../db/client.js';
import { registerRecomputeHandlers } from './recompute.js';
import { registerCrossFlagsHandler, enqueueCrossFlagsJob } from './recompute-cross-flags.js';

// ---------------------------------------------------------------------------
// Payload types (mirrored from POST /ingest enqueue calls)
// ---------------------------------------------------------------------------

interface IngestFilePayload {
  ingestFileId: string;
  ingestJobId: string;
}

interface IngestFinalizePayload {
  ingestJobId: string;
}

// ---------------------------------------------------------------------------
// startWorker
// ---------------------------------------------------------------------------

/**
 * Start the job worker: connect pg-boss and register all known handlers.
 *
 * Returns a teardown function. Call it to stop pg-boss gracefully.
 */
export async function startWorker(): Promise<() => Promise<void>> {
  const logger = getLogger();
  const boss = await getBoss();

  // -------------------------------------------------------------------------
  // Ensure queues exist (pg-boss v10 requires explicit queue creation before
  // boss.send() will insert jobs — the INSERT JOIN skips silently on missing
  // queue rows). createQueue is idempotent; safe to call on every startup.
  // -------------------------------------------------------------------------
  await boss.createQueue(JOB_KINDS.INGEST_FILE);
  await boss.createQueue(JOB_KINDS.INGEST_FINALIZE);
  logger.info('worker: ensured queues exist');

  // -------------------------------------------------------------------------
  // ingest_file handler
  //
  // Per-file pipeline phases 2–5 (dedup → parseBundle → matchStudent →
  // createSubmission). Updates ingest_files.status on each outcome.
  // On completion (success or terminal failure), checks if all sibling files
  // are done and enqueues an ingest_finalize job if so.
  // -------------------------------------------------------------------------

  await boss.work<IngestFilePayload>(JOB_KINDS.INGEST_FILE, { batchSize: 1 }, async (jobs) => {
    const job = jobs[0]!;
    const { ingestFileId, ingestJobId } = job.data;

    const db = getDb();
    const cfg = getConfig();
    const storageClient = createStorageClient(storageConfigFromEnv(cfg));

    logger.info({ ingestFileId, ingestJobId }, 'ingest_file: started');

    try {
      // -----------------------------------------------------------------------
      // Look up the ingest_files row.
      // -----------------------------------------------------------------------
      const fileRows = await db
        .select()
        .from(ingest_files)
        .where(eq(ingest_files.id, ingestFileId));

      if (fileRows.length === 0) {
        logger.warn({ ingestFileId }, 'ingest_file: file row not found, skipping');
        return;
      }

      const fileRow = fileRows[0]!;

      // Skip if already processed (idempotency).
      if (fileRow.status !== 'pending') {
        logger.info({ ingestFileId, status: fileRow.status }, 'ingest_file: already processed');
        return;
      }

      // Mark parent job as running (idempotent — only transitions queued→running).
      await markIngestJobRunning(db, ingestJobId);

      // -----------------------------------------------------------------------
      // Fetch the semester's filename_convention for matchStudent.
      // -----------------------------------------------------------------------
      const jobRows = await db
        .select({ semester_id: ingest_jobs.semester_id })
        .from(ingest_jobs)
        .where(eq(ingest_jobs.id, ingestJobId));

      if (jobRows.length === 0) {
        logger.warn({ ingestJobId }, 'ingest_file: parent ingest_job not found, skipping');
        return;
      }

      const semesterId = jobRows[0]!.semester_id;

      const semesterRows = await db
        .select({ filename_convention: semesters.filename_convention })
        .from(semesters)
        .where(eq(semesters.id, semesterId));

      if (semesterRows.length === 0) {
        logger.warn({ semesterId }, 'ingest_file: semester not found, skipping');
        return;
      }

      const filenameConvention = semesterRows[0]!.filename_convention;

      // -----------------------------------------------------------------------
      // Phase 2: Dedup
      // -----------------------------------------------------------------------
      const dedupResult = await dedupFile(db, semesterId, fileRow.blob_sha256);

      if (dedupResult.isDuplicate) {
        await db
          .update(ingest_files)
          .set({
            status: 'duplicate',
            submission_id: dedupResult.existingSubmissionId,
            resolved_at: new Date(),
          })
          .where(eq(ingest_files.id, ingestFileId));

        logger.info({ ingestFileId }, 'ingest_file: duplicate detected');
        await maybeEnqueueFinalize(boss, db, ingestJobId);
        return;
      }

      // -----------------------------------------------------------------------
      // Phase 3: Parse bundle
      // -----------------------------------------------------------------------
      const stagingKey = ingestStagingKey(ingestJobId, ingestFileId);
      const parsedResult = await parseBundlePhase(
        storageClient,
        stagingKey,
        fileRow.original_filename,
      );

      if (!parsedResult.ok) {
        await db
          .update(ingest_files)
          .set({
            status: 'failed',
            error: {
              phase: parsedResult.phase,
              cause: parsedResult.cause,
              ...(parsedResult.detail !== undefined && { detail: parsedResult.detail }),
            },
            resolved_at: new Date(),
          })
          .where(eq(ingest_files.id, ingestFileId));

        logger.warn({ ingestFileId, cause: parsedResult.cause }, 'ingest_file: parse failed');
        await maybeEnqueueFinalize(boss, db, ingestJobId);
        return;
      }

      const { bundle } = parsedResult;

      // -----------------------------------------------------------------------
      // Phase 4: Match student
      // -----------------------------------------------------------------------

      // Roster resolver: looks up roster_entries.id by (semesterId, sid).
      const rosterResolver = async (semId: string, sid: string) => {
        const { roster_entries } = await import('../db/schema.js');
        const rows = await db
          .select({ id: roster_entries.id })
          .from(roster_entries)
          .where(and(eq(roster_entries.semester_id, semId), eq(roster_entries.sid, sid)))
          .limit(1);
        return rows.length > 0 ? rows[0]!.id : null;
      };

      const matchResult = await matchStudent(
        semesterId,
        filenameConvention,
        fileRow.original_filename,
        bundle.manifest,
        rosterResolver,
      );

      if (!matchResult.matched) {
        await db
          .update(ingest_files)
          .set({
            status: 'unmatched',
            error: { phase: 'match_student', cause: matchResult.reason },
            resolved_at: new Date(),
          })
          .where(eq(ingest_files.id, ingestFileId));

        logger.info({ ingestFileId, reason: matchResult.reason }, 'ingest_file: no student match');
        await maybeEnqueueFinalize(boss, db, ingestJobId);
        return;
      }

      // -----------------------------------------------------------------------
      // Phase 5: Create submission
      // -----------------------------------------------------------------------
      const { studentId, assignmentIdStr, filenameCapture } = matchResult;

      // recorder_version is populated in Phase 10 from session metadata;
      // for Phase 9b just store the format version from the manifest.
      const recorderVersion = '';
      const formatVersion = bundle.manifest.format_version;

      const submissionResult = await createSubmission(
        { db, storageClient },
        {
          semesterId,
          assignmentIdStr,
          studentId,
          blobSha256: fileRow.blob_sha256,
          stagingKey,
          originalFilename: fileRow.original_filename,
          ingestJobId,
          recorderVersion,
          formatVersion,
        },
      );

      // The supersede loop runs OUTSIDE the transaction below.
      // Rationale: these are older submissions' ingest_files rows, possibly from
      // different ingest_jobs. They're best-effort status updates and acceptable
      // to leave at 'superseded' even if the tx below rolls back, because:
      //   1. createSubmission's version_index allocation is FOR-UPDATE-locked, so
      //      the new submission row is already durably committed at this point.
      //   2. pg-boss retry of this file is idempotent — supersededIds will be the
      //      same set, and the UPDATE is set-the-same-value (no-op on retry).
      //   3. Moving this loop INTO the transaction would risk lock-ordering
      //      issues across ingest_files rows from different jobs.
      if (submissionResult.supersededIds.length > 0) {
        // Update older submissions' ingest_files rows to 'superseded'.
        // Note: older ingest_files rows may be from a different ingest_job,
        // so we look them up by submission_id.
        for (const oldSubId of submissionResult.supersededIds) {
          await db
            .update(ingest_files)
            .set({ status: 'superseded' })
            .where(eq(ingest_files.submission_id, oldSubId));
        }
      }

      try {
        await withTransaction(db, async (tx) => {
          try {
            await materializeEvents(tx, submissionResult.submissionId, bundle);
          } catch (e) {
            const cause = e instanceof Error ? e.message : String(e);
            throw Object.assign(new Error(cause), { phase: 'materialize_events' as const });
          }
          try {
            await computeAndStoreStats(tx, submissionResult.submissionId, bundle);
          } catch (e) {
            const cause = e instanceof Error ? e.message : String(e);
            throw Object.assign(new Error(cause), { phase: 'compute_stats' as const });
          }
          let validationReport;
          try {
            validationReport = await runAndStoreValidation(
              tx,
              submissionResult.submissionId,
              bundle,
            );
          } catch (e) {
            const cause = e instanceof Error ? e.message : String(e);
            throw Object.assign(new Error(cause), { phase: 'run_validation' as const });
          }
          try {
            await runAndStoreHeuristics(
              tx,
              submissionResult.submissionId,
              semesterId,
              bundle,
              validationReport,
            );
          } catch (e) {
            const cause = e instanceof Error ? e.message : String(e);
            throw Object.assign(new Error(cause), { phase: 'run_heuristics' as const });
          }
          await tx
            .update(ingest_files)
            .set({
              status: 'matched',
              matched_student_id: studentId,
              matched_assignment_id: submissionResult.assignmentId,
              submission_id: submissionResult.submissionId,
              filename_capture: filenameCapture,
              resolved_at: new Date(),
            })
            .where(eq(ingest_files.id, ingestFileId));
        });
      } catch (err) {
        const cause = err instanceof Error ? err.message : String(err);
        const phase =
          typeof err === 'object' && err !== null && 'phase' in err
            ? (
                err as {
                  phase:
                    | 'materialize_events'
                    | 'compute_stats'
                    | 'run_validation'
                    | 'run_heuristics';
                }
              ).phase
            : 'worker_post_create';
        logger.error(
          { ingestFileId, submissionId: submissionResult.submissionId, err, phase },
          `ingest_file: ${phase} failed`,
        );
        try {
          await db
            .update(ingest_files)
            .set({ status: 'failed', error: { phase, cause }, resolved_at: new Date() })
            .where(and(eq(ingest_files.id, ingestFileId), eq(ingest_files.status, 'pending')));
        } catch {
          // best-effort
        }
        return; // outer finally still calls maybeEnqueueFinalize
      }

      logger.info(
        {
          ingestFileId,
          submissionId: submissionResult.submissionId,
          versionIndex: submissionResult.versionIndex,
        },
        'ingest_file: matched and submission created',
      );
    } catch (err) {
      // Unhandled error — mark file as failed with the error detail.
      const cause = err instanceof Error ? err.message : String(err);
      logger.error({ ingestFileId, err }, 'ingest_file: unhandled error');

      try {
        await db
          .update(ingest_files)
          .set({
            status: 'failed',
            error: { phase: 'worker', cause },
            resolved_at: new Date(),
          })
          .where(and(eq(ingest_files.id, ingestFileId), eq(ingest_files.status, 'pending')));
      } catch {
        // Best-effort — do not re-throw from the error handler.
      }
    } finally {
      // Always check if we're the last pending file, even on error.
      try {
        await maybeEnqueueFinalize(boss, db, ingestJobId);
      } catch {
        // Best-effort.
      }
    }
  });

  // -------------------------------------------------------------------------
  // ingest_finalize handler
  //
  // Reads all ingest_files for the job, aggregates their statuses, and sets
  // the terminal ingest_jobs.status.
  // -------------------------------------------------------------------------

  await boss.work<IngestFinalizePayload>(
    JOB_KINDS.INGEST_FINALIZE,
    { batchSize: 1 },
    async (jobs) => {
      const job = jobs[0]!;
      const { ingestJobId } = job.data;

      const db = getDb();
      logger.info({ ingestJobId }, 'ingest_finalize: started');

      try {
        await finalizeIngestJob(db, ingestJobId);
        logger.info({ ingestJobId }, 'ingest_finalize: completed');

        // Enqueue cross-flag recompute for the semester (Phase 14).
        // Look up semesterId from the ingest_job row.
        // singletonKey=semesterId collapses concurrent enqueues to one pending job.
        // Fire-and-forget: cross-flag failure doesn't affect the ingest job's
        // terminal status (they are independent concerns).
        const jobRows = await db
          .select({ semester_id: ingest_jobs.semester_id })
          .from(ingest_jobs)
          .where(eq(ingest_jobs.id, ingestJobId))
          .limit(1);

        if (jobRows[0]?.semester_id) {
          const semesterId = jobRows[0].semester_id;
          await enqueueCrossFlagsJob(boss, semesterId).catch((err: unknown) => {
            logger.warn(
              { ingestJobId, semesterId, err },
              'ingest_finalize: failed to enqueue recompute_cross_flags (non-fatal)',
            );
          });
        }
      } catch (err) {
        logger.error({ ingestJobId, err }, 'ingest_finalize: error — marking job failed');
        try {
          const cause = err instanceof Error ? err.message : String(err);
          await failIngestJob(db, ingestJobId, `finalize error: ${cause}`);
        } catch {
          // Best-effort.
        }
        throw err; // Let pg-boss retry.
      }
    },
  );

  // Register recompute handlers (Phase 13b).
  await registerRecomputeHandlers(boss);

  // Register cross-flags handler (Phase 14).
  await registerCrossFlagsHandler(boss);

  logger.info('worker started (phase 14: ingest + recompute + cross-flags handlers registered)');

  return async () => {
    await stopBoss();
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * After a file transitions to a terminal status (any status other than
 * 'pending'), check whether all sibling files for the job are also done.
 *
 * If the count of pending files drops to zero, enqueue one `ingest_finalize`
 * job with `singletonKey = ingestJobId`. pg-boss deduplicates concurrent sends
 * so only one finalize runs per job, even if multiple workers trigger this
 * simultaneously.
 */
async function maybeEnqueueFinalize(
  boss: Awaited<ReturnType<typeof getBoss>>,
  db: ReturnType<typeof getDb>,
  ingestJobId: string,
): Promise<void> {
  const pendingCount = await db
    .select({ cnt: count() })
    .from(ingest_files)
    .where(and(eq(ingest_files.ingest_job_id, ingestJobId), eq(ingest_files.status, 'pending')));

  const remaining = pendingCount[0]?.cnt ?? 0;
  if (remaining === 0) {
    // PRD §12.3: finalize jobs retry up to 5 times.
    await boss.send(JOB_KINDS.INGEST_FINALIZE, { ingestJobId } satisfies IngestFinalizePayload, {
      singletonKey: ingestJobId,
      retryLimit: 5,
    });
    getLogger().info({ ingestJobId }, 'ingest_finalize: enqueued');
  }
}
