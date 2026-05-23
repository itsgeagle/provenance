/**
 * purge-expired-exports — daily cron job.
 *
 * Removes expired export artifacts from object storage (and optionally from a
 * dedicated `export_artifacts` table if it exists).
 *
 * TODO(v3.1): The `export_artifacts` table has not been created in the current
 * migration set (Phases 0–14). PDF export was implemented as a stub in Phase 24
 * and the artifact persistence layer was deferred. When Phase 26 (export
 * persistence) lands, this handler should be updated to:
 *   1. SELECT rows FROM export_artifacts WHERE expires_at < now().
 *   2. DELETE their blobs from object storage.
 *   3. DELETE the rows from export_artifacts.
 *
 * For v3.0.0 this is a no-op stub that logs a notice. It is registered in the
 * pg-boss schedule so the cron slot exists and can be re-armed without a deploy.
 *
 * Schedule: '0 3 * * *' (3:00 UTC daily) — registered in worker.ts.
 */

import { getLogger } from '../logging.js';

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export interface PurgeExpiredExportsResult {
  purged: number;
}

/**
 * Stub handler — no-op until export_artifacts table is created in Phase 26.
 */
export async function runPurgeExpiredExports(): Promise<PurgeExpiredExportsResult> {
  const logger = getLogger();
  // TODO(v3.1): implement once export_artifacts table exists (Phase 26).
  logger.debug('purge-expired-exports: no-op stub (export_artifacts table not yet created)');
  return { purged: 0 };
}

// ---------------------------------------------------------------------------
// pg-boss handler factory
// ---------------------------------------------------------------------------

/**
 * Create the pg-boss handler for the `purge_expired_exports` job.
 */
export function createPurgeExpiredExportsHandler(): () => Promise<void> {
  return async () => {
    await runPurgeExpiredExports();
  };
}
