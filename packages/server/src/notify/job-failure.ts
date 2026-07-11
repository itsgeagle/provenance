import type { Notifier } from './types.js';
import type { Severity } from './severity.js';

/**
 * The slice of a pg-boss job shape this wrapper cares about. pg-boss only
 * populates `retryCount`/`retryLimit` when a queue's `work()` handler is
 * registered with `includeMetadata: true` (see `PgBoss.JobWithMetadata`);
 * plain `PgBoss.Job` carries neither field. Declared as a structural type
 * (not imported from `pg-boss`) so this module stays decoupled from the
 * pg-boss job type and the read stays defensive by construction — every
 * field is optional.
 */
interface JobRetryInfo {
  retryCount?: number | undefined;
  retryLimit?: number | undefined;
}

/**
 * Reads `retryCount`/`retryLimit` off an arbitrary job value without
 * assuming its shape. Anything other than a plain object with numeric
 * fields reads back as `undefined` for that field — callers must treat a
 * missing value as "exhausted" (fail safe), never as "not exhausted".
 *
 * `job` is `unknown` at this boundary (the wrapper is generic over the job
 * type `T`, which need not structurally include retry info at compile
 * time), so the cast to `Record<string, unknown>` below is a narrow,
 * defensive read guarded by `typeof`/`in` checks — not a trust boundary
 * violation.
 */
function readRetryInfo(job: unknown): JobRetryInfo {
  if (typeof job !== 'object' || job === null) return {};
  const rec = job as Record<string, unknown>;
  const retryCount = typeof rec.retryCount === 'number' ? rec.retryCount : undefined;
  const retryLimit = typeof rec.retryLimit === 'number' ? rec.retryLimit : undefined;
  return { retryCount, retryLimit };
}

/**
 * Decorates a pg-boss job handler so a terminal (retries-exhausted) failure
 * emits a `job.dead_letter`-style notification before the error is rethrown.
 *
 * Behavior:
 *   - `handler(job)` succeeds → return normally, no notify.
 *   - `handler(job)` throws:
 *     - retries exhausted (`retryCount >= retryLimit`, OR either value is
 *       missing from the job — fail-safe, so we never silently miss a
 *       dead-letter because metadata wasn't available) → `notifier.notify`
 *       once, then rethrow the original error.
 *     - retries remain (`retryCount < retryLimit`, both present) → rethrow
 *       without notifying.
 *
 * The original error is ALWAYS rethrown, in both the notify and no-notify
 * branches — pg-boss must still observe the failure to run its own
 * retry/dead-letter logic. This wrapper only adds a side-channel
 * notification; it never swallows or replaces the error.
 */
export function withFailureNotification<T>(
  opts: { kind: string; severity: Severity; notifier: Notifier },
  handler: (job: T) => Promise<void>,
): (job: T) => Promise<void> {
  return async (job: T): Promise<void> => {
    try {
      await handler(job);
    } catch (err) {
      const { retryCount, retryLimit } = readRetryInfo(job);
      const exhausted =
        retryCount === undefined || retryLimit === undefined || retryCount >= retryLimit;

      if (exhausted) {
        const message = err instanceof Error ? err.message : String(err);
        opts.notifier.notify({
          severity: opts.severity,
          kind: opts.kind,
          title: `job ${opts.kind} failed`,
          detail: { retryCount, error: message },
        });
      }

      throw err;
    }
  };
}
