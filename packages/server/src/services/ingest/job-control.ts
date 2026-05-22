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
import { ingest_jobs } from '../../db/schema.js';
import { eq, and, ne } from 'drizzle-orm';
import { Errors } from '../../api/v1/errors.js';

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
// finalizeIngestJob  (Phase 9a stub)
// ---------------------------------------------------------------------------

/**
 * Finalizes an ingest job after all files have been processed.
 *
 * Phase 9a stub: just validates the job exists and is not already terminal.
 * Phase 9b will replace the body with the full status-aggregation logic
 * (counting matched/unmatched/duplicate/failed file rows, computing
 * 'succeeded'/'partial'/'failed', updating summary jsonb).
 */
export async function finalizeIngestJob(db: DrizzleDb, jobId: string): Promise<void> {
  // Phase 9a: no-op beyond verifying the job exists and is not cancelled.
  const rows = await db.select({ status: ingest_jobs.status }).from(ingest_jobs).where(
    eq(ingest_jobs.id, jobId),
  );

  if (rows.length === 0) {
    // Silently return if the job doesn't exist — worker idempotency.
    return;
  }

  const job = rows[0]!;
  if (job.status === 'cancelled') {
    // Job was cancelled before finalize ran; leave it as is.
    return;
  }

  // Phase 9b will set terminal status here.
}

// ---------------------------------------------------------------------------
// cancelIngestJob
// ---------------------------------------------------------------------------

export interface CancelIngestJobResult {
  ok: true;
}

/**
 * Cancels an ingest job if it is still in a cancellable state (queued/running).
 *
 * Returns the updated job row. Throws NOT_FOUND if the job doesn't exist
 * in the given semester, or if it is already terminal.
 */
export async function cancelIngestJob(
  db: DrizzleDb,
  jobId: string,
  semesterId: string,
): Promise<CancelIngestJobResult> {
  const rows = await db
    .update(ingest_jobs)
    .set({ status: 'cancelled', completed_at: new Date() })
    .where(
      and(
        eq(ingest_jobs.id, jobId),
        eq(ingest_jobs.semester_id, semesterId),
        // Only cancel if not already terminal.
        ne(ingest_jobs.status, 'succeeded'),
        ne(ingest_jobs.status, 'partial'),
        ne(ingest_jobs.status, 'failed'),
        ne(ingest_jobs.status, 'cancelled'),
      ),
    )
    .returning({ id: ingest_jobs.id });

  if (rows.length === 0) {
    // Either the job doesn't exist in this semester, or it's already terminal.
    // Check which case it is.
    const existing = await db
      .select({ id: ingest_jobs.id })
      .from(ingest_jobs)
      .where(and(eq(ingest_jobs.id, jobId), eq(ingest_jobs.semester_id, semesterId)));

    if (existing.length === 0) {
      throw Errors.notFound();
    }

    // Job exists but is already terminal — treat as idempotent success.
    return { ok: true };
  }

  return { ok: true };
}
