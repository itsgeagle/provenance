import type { Notifier } from './types.js';

/** Bound on how long a crash handler waits for sinks to drain before giving up. */
const FLUSH_TIMEOUT_MS = 2000;

/**
 * Handles a fatal (process-ending) error: notifies at `critical` severity with
 * the error message/stack, then drains the notifier so a webhook/email sink
 * gets a chance to fire before the process exits.
 *
 * `flush()` is raced against a timeout so a hung sink can never block process
 * exit. Never throws itself — a crash handler that crashes would defeat the
 * purpose, so notify/flush failures are swallowed.
 */
export async function handleFatal(err: unknown, notifier: Notifier): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;

  try {
    notifier.notify({
      severity: 'critical',
      kind: 'process.crash',
      title: message,
      detail: { message, stack },
    });
  } catch {
    // A crash handler must not itself throw.
  }

  try {
    await Promise.race([
      notifier.flush(),
      new Promise<void>((resolve) => setTimeout(resolve, FLUSH_TIMEOUT_MS)),
    ]);
  } catch {
    // Swallow: a hung/rejecting sink must not block process exit.
  }
}

/**
 * Registers process-level crash handlers: an uncaught synchronous exception or
 * an unhandled promise rejection triggers `handleFatal` (critical notify +
 * bounded flush) and then a non-zero exit. These are last-resort safety nets;
 * they augment, not replace, the app's own error handling.
 */
export function installCrashHandlers(notifier: Notifier): void {
  process.on('uncaughtException', (err: unknown) => {
    void handleFatal(err, notifier).then(() => process.exit(1));
  });
  process.on('unhandledRejection', (reason: unknown) => {
    void handleFatal(reason, notifier).then(() => process.exit(1));
  });
}
