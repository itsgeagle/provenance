/**
 * pg-boss singleton factory.
 *
 * PRD §12: Postgres-backed job queue. pg-boss owns its own queue tables
 * (pgboss.job, etc.); we do NOT mirror queue state into our domain tables.
 *
 * Usage:
 *   const boss = await getBoss();   // starts if not already running
 *   await boss.send('ingest_file', payload);
 *
 * Shutdown:
 *   await stopBoss();               // call from process shutdown handler
 *
 * Job kinds (PRD §12.2):
 *   ingest_file           — per ingest_files row; runs §9.3 phases
 *   ingest_finalize       — last ingest_file completes; aggregates job status
 *   recompute_submission  — per-submission heuristic recompute
 *   recompute_finalize    — last recompute_submission completes
 *   recompute_cross_flags — semester-scoped cross-heuristic sweep
 *   purge_expired_exports — daily cron
 *   purge_expired_sessions — hourly cron
 *   retention_sweep       — daily cron
 *
 * Kinds are registered as a const so future phases can import and reference
 * them without string literals.
 *
 * The singleton is module-level. In tests, call _resetBossForTest() between
 * test runs to force a fresh instance.
 */

import PgBoss from 'pg-boss';
import { getConfig } from '../config/index.js';
import { getLogger } from '../logging.js';

// ---------------------------------------------------------------------------
// Job kind registry
// ---------------------------------------------------------------------------

/**
 * Canonical job kind strings (PRD §12.2).
 *
 * Phases 9b–14 register handlers for these kinds. This list is declared now
 * so the kind names are a single source of truth.
 */
export const JOB_KINDS = {
  INGEST_FILE: 'ingest_file',
  INGEST_FINALIZE: 'ingest_finalize',
  RECOMPUTE_SEMESTER: 'recompute_semester',
  RECOMPUTE_SUBMISSION: 'recompute_submission',
  RECOMPUTE_FINALIZE: 'recompute_finalize',
  RECOMPUTE_CROSS_FLAGS: 'recompute_cross_flags',
  PURGE_EXPIRED_EXPORTS: 'purge_expired_exports',
  PURGE_EXPIRED_SESSIONS: 'purge_expired_sessions',
  RETENTION_SWEEP: 'retention_sweep',
} as const;

export type JobKind = (typeof JOB_KINDS)[keyof typeof JOB_KINDS];

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _boss: PgBoss | null = null;
let _startPromise: Promise<PgBoss> | null = null;

/**
 * Returns the started pg-boss instance, creating and starting it on the first
 * call. Subsequent calls reuse the running instance.
 *
 * Logs a warning if DATABASE_URL is not set (falls back to empty string which
 * pg-boss will reject; let it fail loudly).
 */
export async function getBoss(): Promise<PgBoss> {
  if (_boss !== null) return _boss;

  // Deduplicate concurrent first-calls.
  if (_startPromise !== null) return _startPromise;

  _startPromise = (async () => {
    const config = getConfig();
    const logger = getLogger();

    const boss = new PgBoss({
      connectionString: config.DATABASE_URL,
      // Keep job retention low in development; Phase 25 wires per-kind retention.
      deleteAfterDays: 7,
      // pg-boss defaults: monitorStateIntervalSeconds=120, expireCheckIntervalSeconds=60.
      // Acceptable for v3.0; revisit under load.
    });

    boss.on('error', (err: unknown) => {
      logger.error({ err }, 'pg-boss error');
    });

    await boss.start();
    logger.info('pg-boss started');

    _boss = boss;
    return boss;
  })();

  try {
    return await _startPromise;
  } finally {
    // If start() threw, clear the in-flight promise so the next call retries.
    if (_boss === null) _startPromise = null;
  }
}

/**
 * Stop the pg-boss instance and clear the singleton.
 *
 * Call from the process shutdown handler (SIGTERM, SIGINT) to drain in-flight
 * jobs gracefully. Safe to call if pg-boss was never started.
 */
export async function stopBoss(): Promise<void> {
  const boss = _boss;
  _boss = null;
  _startPromise = null;
  if (boss !== null) {
    await boss.stop();
    getLogger().info('pg-boss stopped');
  }
}

/**
 * @internal Test-only: reset the singleton so the next getBoss() call creates
 * a fresh instance. Does NOT stop the existing instance — callers must stop it
 * themselves if they started it.
 */
export function _resetBossForTest(): void {
  _boss = null;
  _startPromise = null;
}
