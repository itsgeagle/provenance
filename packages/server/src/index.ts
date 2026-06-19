/**
 * CLI entry point.
 *
 * Usage:
 *   node dist/index.js [--mode=<api|worker|all>]   (default: api)
 *
 * Modes are documented in run-mode.ts. In short:
 *   api    — HTTP API server only (production default).
 *   worker — pg-boss job + cron handlers only.
 *   all    — both in one process; for dev / single-machine staging.
 *
 * `npm run dev` passes `--mode=all` so a single dev process serves the API and
 * processes background jobs. Override with `npm run dev -- --mode=api` to run
 * the API alone.
 */
import { parseMode, runMode } from './run-mode.js';

const mode = parseMode(process.argv.slice(2));

runMode(mode)
  .then((teardown) => {
    if (teardown === null) return;
    // Worker (or all) mode owns a pg-boss connection — drain it on shutdown.
    const shutdown = async () => {
      await teardown();
      process.exit(0);
    };
    process.on('SIGTERM', () => void shutdown());
    process.on('SIGINT', () => void shutdown());
  })
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
