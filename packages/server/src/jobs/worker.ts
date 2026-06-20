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
import { recordIngestJobTerminal } from '../api/middleware/metrics.js';
import { timePhase, recordPhase, dumpProfile } from './ingest-profile.js';
import { dedupFile } from '../services/ingest/dedup.js';
import { parseBundlePhase } from '../services/ingest/parse-bundle-phase.js';
import { matchStudent, type MatchStudentResult } from '../services/ingest/match-student.js';
import { createSubmission } from '../services/ingest/create-submission.js';
import { materializeEvents } from '../services/ingest/materialize-events.js';
import { computeAndStoreStats } from '../services/ingest/stats.js';
import { runAndStoreValidation } from '../services/ingest/validation.js';
import { runAndStoreHeuristics } from '../services/heuristics/run-per-submission.js';
import { withTransaction } from '../db/client.js';
import { buildIndex } from '@provenance/analyzer/src/index/build-index.js';
import { registerRecomputeHandlers } from './recompute.js';
import { registerCrossFlagsHandler, enqueueCrossFlagsJob } from './recompute-cross-flags.js';
import { createRetentionSweepHandler } from './retention-sweep.js';
import { createPurgeExpiredSessionsHandler } from './purge-expired-sessions.js';
import { createPurgeExpiredExportsHandler } from './purge-expired-exports.js';

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

  const db = getDb();
  const cfg = getConfig();
  const storageClient = createStorageClient(storageConfigFromEnv(cfg));

  // -------------------------------------------------------------------------
  // Ensure queues exist (pg-boss v10 requires explicit queue creation before
  // boss.send() will insert jobs — the INSERT JOIN skips silently on missing
  // queue rows). createQueue is idempotent; safe to call on every startup.
  // -------------------------------------------------------------------------
  await boss.createQueue(JOB_KINDS.INGEST_FILE);
  await boss.createQueue(JOB_KINDS.INGEST_FINALIZE);
  await boss.createQueue(JOB_KINDS.RETENTION_SWEEP);
  await boss.createQueue(JOB_KINDS.PURGE_EXPIRED_SESSIONS);
  await boss.createQueue(JOB_KINDS.PURGE_EXPIRED_EXPORTS);
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

    const handlerStart = performance.now();
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

      // -----------------------------------------------------------------------
      // Load the parent job up front: we need its status to honor cancellation
      // before doing any work, and its semester_id for matchStudent below.
      // -----------------------------------------------------------------------
      const jobRows = await db
        .select({ status: ingest_jobs.status, semester_id: ingest_jobs.semester_id })
        .from(ingest_jobs)
        .where(eq(ingest_jobs.id, ingestJobId));

      if (jobRows.length === 0) {
        logger.warn({ ingestJobId }, 'ingest_file: parent ingest_job not found, skipping');
        return;
      }

      const { status: jobStatus, semester_id: semesterId } = jobRows[0]!;

      // Cooperative-cancellation gate. If the parent job was cancelled while this
      // file was still queued — or pg-boss replayed the job after a server
      // restart — do NOT process it. Mark the still-pending file 'discarded' and
      // bail. This is the single source of truth for cancellation: it covers
      // queued, in-flight, and restart-replayed jobs in one place. The outer
      // finally still runs maybeEnqueueFinalize so the job can settle its summary.
      if (jobStatus === 'cancelled') {
        logger.info({ ingestFileId, ingestJobId }, 'ingest_file: parent job cancelled, discarding');
        await db
          .update(ingest_files)
          .set({
            status: 'discarded',
            error: { phase: 'worker', cause: 'ingest_job_cancelled' },
            resolved_at: new Date(),
          })
          .where(and(eq(ingest_files.id, ingestFileId), eq(ingest_files.status, 'pending')));
        return;
      }

      // Mark parent job as running (idempotent — only transitions queued→running).
      await markIngestJobRunning(db, ingestJobId);

      // -----------------------------------------------------------------------
      // Fetch the semester's filename_convention for matchStudent.
      // -----------------------------------------------------------------------
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
      // Roster resolver: looks up roster_entries.id by (semesterId, sid).
      // Shared by the match-hint path (below) and the Phase 4 filename match.
      // -----------------------------------------------------------------------
      const rosterResolver = async (semId: string, sid: string) => {
        const { roster_entries } = await import('../db/schema.js');
        const rows = await db
          .select({ id: roster_entries.id })
          .from(roster_entries)
          .where(and(eq(roster_entries.semester_id, semId), eq(roster_entries.sid, sid)))
          .limit(1);
        return rows.length > 0 ? rows[0]!.id : null;
      };

      // -----------------------------------------------------------------------
      // Match hint (Gradescope export ingest): when ingest_files.match_sid is
      // set, the student identity was resolved from submission_metadata.yml at
      // upload time. Resolve it now so Phase 2 dedup can be scoped per-student
      // (co-submitters of one group bundle each keep their own submission) and
      // Phase 4 can skip the filename_convention regex. An unknown sid lands in
      // the unmatched tray, same as the filename path.
      // -----------------------------------------------------------------------
      const hintSid = fileRow.match_sid;
      let hintedStudentId: string | null = null;
      if (hintSid !== null) {
        hintedStudentId = await rosterResolver(semesterId, hintSid);
        if (hintedStudentId === null) {
          await db
            .update(ingest_files)
            .set({
              status: 'unmatched',
              error: { phase: 'match_student', cause: 'unknown_sid' },
              resolved_at: new Date(),
            })
            .where(eq(ingest_files.id, ingestFileId));

          logger.info({ ingestFileId, sid: hintSid }, 'ingest_file: match_sid not found in roster');
          await maybeEnqueueFinalize(boss, db, ingestJobId);
          return;
        }
      }

      // -----------------------------------------------------------------------
      // Phase 2: Dedup
      //
      // Hinted (Gradescope) files dedup per (semester, student, blob); normal
      // files dedup per (semester, blob). See dedupFile docs.
      // -----------------------------------------------------------------------
      recordPhase('setup:db_lookups', performance.now() - handlerStart);

      const dedupResult = await timePhase('dedup', () =>
        dedupFile(db, semesterId, fileRow.blob_sha256, hintedStudentId ?? undefined),
      );

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
      const parsedResult = await timePhase('parse_bundle', () =>
        parseBundlePhase(storageClient, stagingKey, fileRow.original_filename),
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
      //
      // Hinted (Gradescope) files match directly to the student resolved from
      // match_sid above, with the assignment taken from the signed bundle
      // manifest. Normal files run the semester's filename_convention regex.
      // (When hintSid is set we already returned above on an unknown sid, so
      // hintedStudentId is non-null here.)
      // -----------------------------------------------------------------------
      const matchResult: MatchStudentResult =
        hintSid !== null
          ? {
              matched: true,
              studentId: hintedStudentId!,
              assignmentIdStr: bundle.manifest.assignment_id,
              filenameCapture: { sid: hintSid },
            }
          : await timePhase('match_student', () =>
              matchStudent(
                semesterId,
                filenameConvention,
                fileRow.original_filename,
                bundle.manifest,
                rosterResolver,
              ),
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

      const submissionResult = await timePhase('create_submission', () =>
        createSubmission(
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
        ),
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
        await timePhase('supersede', async () => {
          for (const oldSubId of submissionResult.supersededIds) {
            await db
              .update(ingest_files)
              .set({ status: 'superseded' })
              .where(eq(ingest_files.submission_id, oldSubId));
          }
        });
      }

      // Lever B: build the chronological index ONCE and share it across the
      // materialize / stats / heuristics phases (each formerly rebuilt it).
      // Shortens the transaction below and cuts per-bundle allocation/GC.
      const index = await timePhase('build_index', () =>
        Promise.resolve(buildIndex(bundle)),
      );

      try {
        await timePhase('tx_total', () =>
        withTransaction(db, async (tx) => {
          try {
            await timePhase('materialize_events', () =>
              materializeEvents(tx, submissionResult.submissionId, bundle, index),
            );
          } catch (e) {
            const cause = e instanceof Error ? e.message : String(e);
            throw Object.assign(new Error(cause), { phase: 'materialize_events' as const });
          }
          try {
            await timePhase('compute_stats', () =>
              computeAndStoreStats(tx, submissionResult.submissionId, bundle, index),
            );
          } catch (e) {
            const cause = e instanceof Error ? e.message : String(e);
            throw Object.assign(new Error(cause), { phase: 'compute_stats' as const });
          }
          let validationReport;
          try {
            validationReport = await timePhase('run_validation', () =>
              runAndStoreValidation(tx, submissionResult.submissionId, bundle),
            );
          } catch (e) {
            const cause = e instanceof Error ? e.message : String(e);
            throw Object.assign(new Error(cause), { phase: 'run_validation' as const });
          }
          try {
            await timePhase('run_heuristics', () =>
              runAndStoreHeuristics(
                tx,
                submissionResult.submissionId,
                semesterId,
                bundle,
                validationReport,
                index,
              ),
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
        }),
        );
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
      recordPhase('handler_total', performance.now() - handlerStart);
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

        // Record the terminal status to metrics.
        const statusRows = await db
          .select({ status: ingest_jobs.status })
          .from(ingest_jobs)
          .where(eq(ingest_jobs.id, ingestJobId))
          .limit(1);

        const finalStatus = statusRows[0]?.status ?? 'unknown';
        if (['succeeded', 'partial', 'failed'].includes(finalStatus)) {
          recordIngestJobTerminal(finalStatus);
        }

        logger.info({ ingestJobId }, 'ingest_finalize: completed');

        // Dev profiling (INGEST_PROFILE=1): the batch's per-file work is done by
        // the time finalize runs, so dump the accumulated per-phase table.
        dumpProfile((msg) => logger.info({ profile: true }, msg));

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

  // -------------------------------------------------------------------------
  // Cron job handlers (Phase 25)
  // -------------------------------------------------------------------------

  await boss.work(
    JOB_KINDS.RETENTION_SWEEP,
    { batchSize: 1 },
    createRetentionSweepHandler(db, storageClient),
  );

  await boss.work(
    JOB_KINDS.PURGE_EXPIRED_SESSIONS,
    { batchSize: 1 },
    createPurgeExpiredSessionsHandler(db),
  );

  await boss.work(
    JOB_KINDS.PURGE_EXPIRED_EXPORTS,
    { batchSize: 1 },
    createPurgeExpiredExportsHandler(),
  );

  // -------------------------------------------------------------------------
  // Register pg-boss scheduled (cron) jobs.
  //
  // boss.schedule() is idempotent — it upserts the schedule row in
  // pgboss.schedule. Safe to call on every startup.
  //
  // UTC times chosen to avoid overlap with peak US-West-Coast usage:
  //   2:00 UTC = 6pm/7pm PST (off-hours)
  //   3:00 UTC = 7pm/8pm PST (off-hours)
  //   hourly   = predictable for monitoring
  // -------------------------------------------------------------------------

  // retention_sweep — 2am UTC daily (PRD §16).
  await boss.schedule(JOB_KINDS.RETENTION_SWEEP, '0 2 * * *', {});

  // purge_expired_sessions — every hour on the hour.
  await boss.schedule(JOB_KINDS.PURGE_EXPIRED_SESSIONS, '0 * * * *', {});

  // purge_expired_exports — 3am UTC daily (stub until Phase 26).
  await boss.schedule(JOB_KINDS.PURGE_EXPIRED_EXPORTS, '0 3 * * *', {});

  logger.info(
    'worker started (phase 25: ingest + recompute + cross-flags + cron handlers registered)',
  );

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
