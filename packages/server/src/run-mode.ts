/**
 * Mode dispatch for the server CLI entry point.
 *
 * Extracted from index.ts so the api/worker/all wiring is unit-testable without
 * booting a real HTTP server or pg-boss connection (inject `deps`).
 *
 * Modes (analyzer PRD §6.1):
 *   api    — HTTP API server only.
 *   worker — pg-boss job + cron handlers only.
 *   all    — both, in one process. For development / single-machine staging;
 *            in production run `api` and `worker` as separate, independently
 *            scaled processes.
 */
import { startApi } from './api/start.js';
import { startWorker } from './jobs/worker.js';
import { stopBoss } from './jobs/pg-boss.js';

export const RUN_MODES = ['api', 'worker', 'all'] as const;
export type RunMode = (typeof RUN_MODES)[number];

export interface ModeDeps {
  startApi: () => void;
  startWorker: () => Promise<() => Promise<void>>;
  /** Drains the pg-boss singleton on shutdown; no-op if it was never started. */
  stopBoss: () => Promise<void>;
}

/**
 * Parse the `--mode=<x>` flag from argv. The last occurrence wins, so a script
 * default (e.g. `npm run dev` passes `--mode=all`) can still be overridden on
 * the command line (`npm run dev -- --mode=worker`). Defaults to `api` when
 * absent — the production-safe default for a bare `node dist/index.js`.
 */
export function parseMode(argv: readonly string[]): string {
  const prefix = '--mode=';
  let mode = 'api';
  for (const arg of argv) {
    if (arg.startsWith(prefix)) mode = arg.slice(prefix.length);
  }
  return mode;
}

/**
 * Start the requested mode.
 *
 * Always returns a teardown function so the caller can wire it to
 * SIGTERM/SIGINT. In `api` mode the teardown drains the pg-boss singleton that
 * the API lazily starts to enqueue jobs (a no-op if nothing was ever
 * enqueued); in `worker` / `all` it is the worker's own teardown (which also
 * stops pg-boss). Throws on an unknown mode.
 */
export async function runMode(
  mode: string,
  deps: ModeDeps = { startApi, startWorker, stopBoss },
): Promise<(() => Promise<void>) | null> {
  switch (mode) {
    case 'api':
      deps.startApi();
      // The API enqueues via the lazily-started pg-boss singleton; drain it on
      // shutdown so we don't leave a background instance undrained.
      return deps.stopBoss;
    case 'worker':
      return deps.startWorker();
    case 'all':
      deps.startApi();
      return deps.startWorker();
    default:
      throw new Error(`Unknown --mode="${mode}". Expected: ${RUN_MODES.join(' | ')}`);
  }
}
