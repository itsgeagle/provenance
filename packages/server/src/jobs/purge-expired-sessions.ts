/**
 * purge-expired-sessions — hourly cron job.
 *
 * Deletes sessions where `expires_at < now()`. The sessions table has an index
 * on `expires_at` (sessions_expires_at_idx from migration 0001) so the DELETE
 * uses an index scan and is efficient even at large table sizes.
 *
 * Contract:
 *   - Deletes only rows where expires_at IS IN THE PAST — never future sessions.
 *   - Idempotent: re-running on an already-clean table is a no-op.
 *   - Runs as a pg-boss scheduled job at the top of every hour.
 *
 * Schedule: '0 * * * *' (every hour on the hour UTC) — registered in worker.ts.
 */

import { lt, sql } from 'drizzle-orm';
import type { DrizzleDb } from '../db/client.js';
import { sessions } from '../db/schema.js';
import { getLogger } from '../logging.js';

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export interface PurgeExpiredSessionsResult {
  purged: number;
}

/**
 * Delete all sessions where expires_at < now().
 *
 * @param db - Drizzle DB instance
 * @returns  Summary with count of deleted rows.
 */
export async function runPurgeExpiredSessions(db: DrizzleDb): Promise<PurgeExpiredSessionsResult> {
  const logger = getLogger();

  const result = await db
    .delete(sessions)
    .where(lt(sessions.expires_at, sql`now()`))
    .returning({ id: sessions.id });

  const purged = result.length;
  logger.info({ purged }, 'purge-expired-sessions: complete');

  return { purged };
}

// ---------------------------------------------------------------------------
// pg-boss handler factory
// ---------------------------------------------------------------------------

/**
 * Create the pg-boss handler for the `purge_expired_sessions` job.
 */
export function createPurgeExpiredSessionsHandler(db: DrizzleDb): () => Promise<void> {
  return async () => {
    await runPurgeExpiredSessions(db);
  };
}
