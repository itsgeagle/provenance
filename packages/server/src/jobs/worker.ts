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
 */

import { getBoss, stopBoss, JOB_KINDS } from './pg-boss.js';
import { getLogger } from '../logging.js';

/**
 * Start the job worker: connect pg-boss and register all known handlers.
 *
 * Registers an empty handler stub for each phase-9a-defined kind so pg-boss
 * recognises the queues. Real handlers are registered in later phases.
 *
 * Returns a teardown function. Call it to stop pg-boss gracefully.
 */
export async function startWorker(): Promise<() => Promise<void>> {
  const logger = getLogger();
  const boss = await getBoss();

  // -------------------------------------------------------------------------
  // Job handler registrations.
  //
  // Phase 9a stubs: each kind is registered so pg-boss acknowledges queue
  // creation. Handlers added in 9b+ replace these.
  // -------------------------------------------------------------------------

  // ingest_file: full per-file pipeline (phases 9b+).
  // WorkHandler receives Job<T>[] (batch); batchSize: 1 means one job per call.
  await boss.work(JOB_KINDS.INGEST_FILE, { batchSize: 1 }, async (jobs) => {
    const job = jobs[0]!;
    logger.warn({ jobId: job.id, name: job.name }, 'ingest_file handler not yet implemented');
  });

  // ingest_finalize: aggregate file statuses → job terminal status (phases 9b+).
  await boss.work(JOB_KINDS.INGEST_FINALIZE, { batchSize: 1 }, async (jobs) => {
    const job = jobs[0]!;
    logger.warn({ jobId: job.id, name: job.name }, 'ingest_finalize handler not yet implemented');
  });

  logger.info('worker started (phase 9a: handlers registered as stubs)');

  return async () => {
    await stopBoss();
  };
}
