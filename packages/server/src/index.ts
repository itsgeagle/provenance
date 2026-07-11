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
import { hostname } from 'node:os';
import { parseMode, runMode } from './run-mode.js';
import { getNotifier } from './notify/notifier.js';
import { startupEvent, shutdownEvent } from './notify/lifecycle.js';
import { installCrashHandlers } from './notify/fatal.js';
import { getConfig } from './config/index.js';

const mode = parseMode(process.argv.slice(2));
// Container hostname distinguishes scaled worker replicas in the alert feed.
const host = hostname();

// Last-resort safety net: notify + bounded flush before exiting on an
// otherwise-unhandled crash. Installed before runMode() so it also covers
// crashes during startup.
installCrashHandlers(getNotifier());

runMode(mode)
  .then((teardown) => {
    getNotifier().notify(
      startupEvent({
        mode,
        sha: getConfig().GIT_SHA,
        backend: getConfig().BLOB_STORAGE_BACKEND,
        host,
      }),
    );

    if (teardown === null) return;
    // Every mode now returns a teardown (api drains its lazily-started pg-boss;
    // worker/all drain the worker + pg-boss) — drain it on shutdown.
    const shutdown = async (signal: string) => {
      getNotifier().notify(shutdownEvent({ mode, signal, host }));
      // Bound the flush so a hung sink can't stall shutdown until SIGKILL
      // (mirrors handleFatal's bounded flush).
      await Promise.race([
        getNotifier().flush(),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
      await teardown();
      process.exit(0);
    };
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));
  })
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
