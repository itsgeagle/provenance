/**
 * Ingest job lifecycle control (PRD §9.1).
 *
 * Status transitions:
 *   ingest_jobs: queued -> running -> { succeeded | partial | failed | cancelled }
 *
 * This module owns inserts and updates to `ingest_jobs`. The per-file pipeline
 * updates `ingest_files` rows directly; `finalizeIngestJob` (Phase 9b) reads
 * them to compute the terminal job status.
 *
 * Phase 9a scope:
 *   - enqueueIngestJob: creates the job row with status='queued'.
 *   - finalizeIngestJob: stub — full logic (counting file statuses, computing
 *     'succeeded'/'partial'/'failed') lands in Phase 9b.
 *   - cancelIngestJob: sets status='cancelled'.
 */

import type { DrizzleDb } from '../../db/client.js';
import { ingest_jobs, ingest_files } from '../../db/schema.js';
import { eq, and, ne } from 'drizzle-orm';
import { Errors } from '../../api/v1/errors.js';

// ---------------------------------------------------------------------------
// failIngestJob
// ---------------------------------------------------------------------------

/**
 * Marks an ingest job as failed with an optional error detail string.
 *
 * Called as a compensation path when staging fails mid-batch. Any blobs
 * already staged to MinIO are left as orphans — the retention sweep (Phase 9c)
 * will clean them up.
 *
 * Silently no-ops if the job doesn't exist (worker idempotency).
 */
export async function failIngestJob(
  db: DrizzleDb,
  jobId: string,
  errorDetail?: string,
): Promise<void> {
  await db
    .update(ingest_jobs)
    .set({
      status: 'failed',
      completed_at: new Date(),
      summary: errorDetail !== undefined ? { error: errorDetail } : {},
    })
    .where(eq(ingest_jobs.id, jobId));
}

// ---------------------------------------------------------------------------
// markIngestJobRunning
// ---------------------------------------------------------------------------

/**
 * Transitions an ingest job from 'queued' to 'running'.
 *
 * Called when the first `ingest_file` worker picks up a file for this job.
 * Idempotent: if the job is already 'running' (another worker beat us to it),
 * the update is a no-op.
 *
 * Does not update 'cancelled', 'failed', or other terminal states.
 */
export async function markIngestJobRunning(db: DrizzleDb, jobId: string): Promise<void> {
  await db
    .update(ingest_jobs)
    .set({ status: 'running', started_at: new Date() })
    .where(and(eq(ingest_jobs.id, jobId), eq(ingest_jobs.status, 'queued')));
}

// ---------------------------------------------------------------------------
// enqueueIngestJob
// ---------------------------------------------------------------------------

export interface EnqueueIngestJobResult {
  jobId: string;
}

/**
 * Creates an ingest_jobs row with status='queued'.
 *
 * Does NOT enqueue a pg-boss job — the caller (route handler) does that
 * after creating the ingest_files rows. This keeps the DB insert and the
 * queue send in the same logical unit as close as possible.
 */
export async function enqueueIngestJob(
  db: DrizzleDb,
  semesterId: string,
  userId: string,
): Promise<EnqueueIngestJobResult> {
  const rows = await db
    .insert(ingest_jobs)
    .values({
      semester_id: semesterId,
      uploaded_by: userId,
      status: 'queued',
      summary: {},
    })
    .returning({ id: ingest_jobs.id });

  const row = rows[0];
  if (!row) {
    throw Errors.internal(undefined, 'enqueueIngestJob: insert returned no rows');
  }

  return { jobId: row.id };
}

// ---------------------------------------------------------------------------
// finalizeIngestJob  (Phase 9b)
// ---------------------------------------------------------------------------

/**
 * Summary counts computed from ingest_files rows.
 */
export interface IngestJobSummary {
  total: number;
  matched: number;
  unmatched: number;
  duplicate: number;
  failed: number;
  superseded: number;
  discarded: number;
}

/**
 * Finalizes an ingest job after all files have been processed.
 *
 * Reads all `ingest_files` for the job, counts statuses, computes the
 * terminal job status, and updates `ingest_jobs`.
 *
 * Terminal status rules (PRD §9.3):
 *   - 'succeeded'  — every file is in {matched, duplicate, superseded}.
 *   - 'partial'    — at least one file is in {failed, unmatched, discarded}
 *                    but the run otherwise completed.
 *   - 'failed'     — the caller explicitly requests failure (e.g. unrecoverable
 *                    worker error). Use `failIngestJob` for that path instead.
 *
 * Idempotent: silently no-ops if the job is already in a terminal or cancelled
 * state.
 */
export async function finalizeIngestJob(db: DrizzleDb, jobId: string): Promise<void> {
  const rows = await db
    .select({ status: ingest_jobs.status })
    .from(ingest_jobs)
    .where(eq(ingest_jobs.id, jobId));

  if (rows.length === 0) {
    // Silently return if the job doesn't exist — worker idempotency.
    return;
  }

  const job = rows[0]!;
  // If already terminal or cancelled, leave as-is (idempotent).
  const terminalStatuses = ['succeeded', 'partial', 'failed', 'cancelled'];
  if (terminalStatuses.includes(job.status)) {
    return;
  }

  // Count file statuses.
  const fileRows = await db
    .select({ status: ingest_files.status })
    .from(ingest_files)
    .where(eq(ingest_files.ingest_job_id, jobId));

  const summary: IngestJobSummary = {
    total: fileRows.length,
    matched: 0,
    unmatched: 0,
    duplicate: 0,
    failed: 0,
    superseded: 0,
    discarded: 0,
  };

  for (const f of fileRows) {
    switch (f.status) {
      case 'matched':    summary.matched++;    break;
      case 'unmatched':  summary.unmatched++;  break;
      case 'duplicate':  summary.duplicate++;  break;
      case 'failed':     summary.failed++;     break;
      case 'superseded': summary.superseded++; break;
      case 'discarded':  summary.discarded++;  break;
      // 'pending' and any unrecognized status: ignored (not counted in named fields).
    }
  }

  // Determine terminal job status.
  const hasProblems =
    summary.failed > 0 || summary.unmatched > 0 || summary.discarded > 0;

  const terminalStatus = hasProblems ? 'partial' : 'succeeded';

  await db
    .update(ingest_jobs)
    .set({
      status: terminalStatus,
      completed_at: new Date(),
      summary: summary as unknown as Record<string, unknown>,
    })
    .where(eq(ingest_jobs.id, jobId));
}

// ---------------------------------------------------------------------------
// cancelIngestJob
// ---------------------------------------------------------------------------

export interface CancelIngestJobResult {
  /** Whether this call actually transitioned the job to cancelled. */
  cancelled: boolean;
  /** The status the job was in before this call. */
  previous_status: string;
}

/**
 * Cancels an ingest job if it is still in a cancellable state (queued/running).
 *
 * Returns `{ cancelled, previous_status }`:
 *   - `cancelled: true`  — job was queued/running and is now cancelled.
 *   - `cancelled: false` — job was already cancelled (idempotent, no-op).
 *
 * Throws NOT_FOUND if the job doesn't exist in the given semester.
 * Throws INGEST_JOB_NOT_CANCELLABLE (409) if the job is in a terminal state
 * other than 'cancelled' (i.e. succeeded / partial / failed).
 */
export async function cancelIngestJob(
  db: DrizzleDb,
  jobId: string,
  semesterId: string,
): Promise<CancelIngestJobResult> {
  // First, fetch the current status so we can give precise feedback.
  const existing = await db
    .select({ id: ingest_jobs.id, status: ingest_jobs.status })
    .from(ingest_jobs)
    .where(and(eq(ingest_jobs.id, jobId), eq(ingest_jobs.semester_id, semesterId)));

  if (existing.length === 0) {
    throw Errors.notFound();
  }

  const currentStatus = existing[0]!.status;

  // Already cancelled — idempotent no-op.
  if (currentStatus === 'cancelled') {
    return { cancelled: false, previous_status: currentStatus };
  }

  // Terminal (non-cancellable) states.
  if (currentStatus === 'succeeded' || currentStatus === 'partial' || currentStatus === 'failed') {
    throw Errors.ingestJobNotCancellable(currentStatus);
  }

  // Cancel it (queued or running).
  await db
    .update(ingest_jobs)
    .set({ status: 'cancelled', completed_at: new Date() })
    .where(
      and(
        eq(ingest_jobs.id, jobId),
        eq(ingest_jobs.semester_id, semesterId),
        ne(ingest_jobs.status, 'succeeded'),
        ne(ingest_jobs.status, 'partial'),
        ne(ingest_jobs.status, 'failed'),
        ne(ingest_jobs.status, 'cancelled'),
      ),
    );

  return { cancelled: true, previous_status: currentStatus };
}
