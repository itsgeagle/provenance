/**
 * A tiny bounded-concurrency task runner.
 *
 * `submit(task)` starts the task immediately when fewer than `limit` are in
 * flight, otherwise it awaits a free slot (backpressure) before returning — so
 * the caller can drive it from a serial loop and stays memory-bounded. The
 * first task error is remembered and re-thrown from the next `submit`/`drain`,
 * mirroring a serial `await` loop's fail-fast behavior; `settle()` waits for
 * in-flight tasks without throwing (for cleanup on an error path).
 *
 * `limit <= 1` is exactly serial: `submit` awaits the previous task before
 * starting the next, so behavior is identical to a plain `for`-loop of awaits.
 */
export interface BoundedRunner {
  /** Start `task`, first awaiting a free slot. Throws the first prior error. */
  submit(task: () => Promise<void>): Promise<void>;
  /** Await all in-flight tasks; throws if any task failed. */
  drain(): Promise<void>;
  /** Await all in-flight tasks, swallowing errors (cleanup on failure paths). */
  settle(): Promise<void>;
}

export function createBoundedRunner(limit: number): BoundedRunner {
  const max = Math.max(1, Math.floor(limit));
  const inFlight = new Set<Promise<void>>();
  let firstError: unknown = null;

  const throwIfFailed = (): void => {
    if (firstError !== null) throw firstError;
  };

  return {
    async submit(task) {
      throwIfFailed();
      while (inFlight.size >= max) {
        await Promise.race(inFlight);
        throwIfFailed();
      }
      // `p` is referenced in its own `.finally`, but that callback only runs
      // after the task settles — well after `p` is bound — so `const` is safe.
      const p: Promise<void> = task()
        .catch((e: unknown) => {
          if (firstError === null) firstError = e;
        })
        .finally(() => {
          inFlight.delete(p);
        });
      inFlight.add(p);
    },
    async drain() {
      await Promise.allSettled(inFlight);
      throwIfFailed();
    },
    async settle() {
      await Promise.allSettled(inFlight);
    },
  };
}
