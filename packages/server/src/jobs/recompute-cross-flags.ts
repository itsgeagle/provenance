/**
 * recompute_cross_flags pg-boss handler — Phase 14.
 *
 * Registered in worker.ts alongside the ingest and recompute handlers.
 *
 * ## Payload
 *
 *   { semesterId: string }
 *
 * ## Retry policy (PRD §12.3)
 *
 *   retryLimit: 5 (same class as recompute_finalize — cheap, must complete)
 *   Sent with singletonKey: semesterId so concurrent enqueues (from multiple
 *   ingest jobs finishing in the same semester) collapse to one pending job.
 *
 * ## Advisory lock strategy (V32)
 *
 * We use Postgres advisory locks in addition to singletonKey:
 *
 *   singletonKey=semesterId collapses PENDING duplicates (at most one queued
 *   job per semester). But if two workers pick up two queued jobs for the same
 *   semester before either starts (edge case: the queue had two entries before
 *   the singleton-key dedup fired), they could run concurrently and race on the
 *   DELETE-then-INSERT inside runAndStoreCrossHeuristics.
 *
 *   pg_advisory_lock(hash(semesterId)) prevents this race: the second worker
 *   blocks on the lock until the first finishes, then runs its own full sweep
 *   (producing the same result — idempotent). In steady state (singletonKey
 *   working correctly) the lock is uncontested.
 *
 *   The hash is computed as: ('x' || substr(md5(semesterId), 1, 16))::bit(64)::bigint
 *   This is a Postgres idiom for hashing a UUID string to a bigint (V32 decision).
 *
 * ## Error handling
 *
 *   On error: log + re-throw so pg-boss retries (up to retryLimit: 5).
 *   Advisory lock is released automatically on error (session-level lock is
 *   released when the connection is returned to the pool, or explicitly via
 *   pg_advisory_unlock in the finally block).
 */

import type PgBoss from 'pg-boss';
import { sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { getLogger } from '../logging.js';
import { JOB_KINDS } from './pg-boss.js';
import { runAndStoreCrossHeuristics } from '../services/heuristics/run-cross.js';

// ---------------------------------------------------------------------------
// Payload type
// ---------------------------------------------------------------------------

export interface RecomputeCrossFlagsPayload {
  semesterId: string;
}

// ---------------------------------------------------------------------------
// Public: enqueue helper
// ---------------------------------------------------------------------------

/**
 * Enqueue a recompute_cross_flags job for a semester.
 *
 * Uses singletonKey=semesterId so multiple concurrent enqueues collapse to one.
 * Safe to call from both ingest_finalize and recompute_finalize handlers.
 *
 * @param boss       - The pg-boss instance.
 * @param semesterId - UUID of the semester to enqueue for.
 */
export async function enqueueCrossFlagsJob(boss: PgBoss, semesterId: string): Promise<void> {
  await boss.send(
    JOB_KINDS.RECOMPUTE_CROSS_FLAGS,
    { semesterId } satisfies RecomputeCrossFlagsPayload,
    {
      singletonKey: semesterId,
      retryLimit: 5, // PRD §12.3 — same class as recompute_finalize
    },
  );
  getLogger().info({ semesterId }, 'recompute_cross_flags: enqueued');
}

// ---------------------------------------------------------------------------
// Handler registration
// ---------------------------------------------------------------------------

/**
 * Register the recompute_cross_flags handler on the given pg-boss instance.
 *
 * Called from startWorker() in worker.ts after the other handlers are registered.
 */
export async function registerCrossFlagsHandler(boss: PgBoss): Promise<void> {
  const logger = getLogger();

  await boss.createQueue(JOB_KINDS.RECOMPUTE_CROSS_FLAGS);
  logger.info('worker: recompute_cross_flags queue ensured');

  await boss.work<RecomputeCrossFlagsPayload>(
    JOB_KINDS.RECOMPUTE_CROSS_FLAGS,
    { batchSize: 1 },
    async (jobs) => {
      const job = jobs[0]!;
      const { semesterId } = job.data;
      const db = getDb();
      logger.info({ semesterId }, 'recompute_cross_flags: started');

      // -----------------------------------------------------------------------
      // Acquire semester-scoped advisory lock (V32).
      //
      // Hash semesterId to a bigint using Postgres md5-based idiom.
      // pg_advisory_lock is session-level: automatically released when the
      // connection is closed or on explicit pg_advisory_unlock. We release
      // explicitly in the finally block for cleanliness.
      // -----------------------------------------------------------------------
      let lockAcquired = false;

      try {
        await db.execute(sql`
          SELECT pg_advisory_lock(
            ('x' || substr(md5(${semesterId}), 1, 16))::bit(64)::bigint
          )
        `);
        lockAcquired = true;

        logger.info({ semesterId }, 'recompute_cross_flags: advisory lock acquired');

        const result = await runAndStoreCrossHeuristics(db, semesterId);

        logger.info(
          { semesterId, flag_count: result.flag_count, participant_count: result.participant_count },
          'recompute_cross_flags: completed',
        );
      } catch (err) {
        logger.error({ semesterId, err }, 'recompute_cross_flags: error');
        throw err; // Let pg-boss retry (retryLimit: 5).
      } finally {
        if (lockAcquired) {
          try {
            await db.execute(sql`
              SELECT pg_advisory_unlock(
                ('x' || substr(md5(${semesterId}), 1, 16))::bit(64)::bigint
              )
            `);
          } catch (unlockErr) {
            // Best-effort unlock. If this fails, the lock will be released
            // when the connection is returned to the pool.
            logger.warn({ semesterId, unlockErr }, 'recompute_cross_flags: advisory unlock failed');
          }
        }
      }
    },
  );

  logger.info('worker: recompute_cross_flags handler registered');
}
