import { describe, it, expect } from 'vitest';
import { createBoundedRunner } from './bounded-runner.js';

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Flush the macrotask queue so all pending microtask continuations settle.
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('createBoundedRunner', () => {
  it('never exceeds the concurrency limit and drain waits for every task', async () => {
    const runner = createBoundedRunner(2);
    const gates = Array.from({ length: 5 }, () => deferred());
    let active = 0;
    let maxActive = 0;
    let completed = 0;

    const submitAll = (async () => {
      for (let i = 0; i < 5; i++) {
        await runner.submit(async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          await gates[i]!.promise;
          active--;
          completed++;
        });
      }
    })();

    await flush();
    expect(active).toBe(2); // exactly the limit is running; the rest wait in submit()

    gates[0]!.resolve();
    await flush();
    expect(active).toBe(2); // freed slot immediately reused, still capped
    expect(maxActive).toBe(2);

    for (const g of gates) g.resolve();
    await submitAll;
    await runner.drain();

    expect(completed).toBe(5);
    expect(maxActive).toBe(2);
  });

  it('limit <= 1 runs strictly one at a time', async () => {
    const runner = createBoundedRunner(1);
    let active = 0;
    let maxActive = 0;
    for (let i = 0; i < 4; i++) {
      await runner.submit(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active--;
      });
    }
    await runner.drain();
    expect(maxActive).toBe(1);
  });

  it('drain rejects with the first task error', async () => {
    const runner = createBoundedRunner(2);
    await runner.submit(async () => {
      throw new Error('boom');
    });
    await expect(runner.drain()).rejects.toThrow('boom');
  });

  it('a later submit surfaces an earlier task failure (fail-fast)', async () => {
    const runner = createBoundedRunner(1);
    await runner.submit(async () => {
      throw new Error('boom');
    });
    // With the slot occupied by the failed task, the next submit awaits it and
    // then re-throws its error instead of starting more work.
    await expect(runner.submit(async () => {})).rejects.toThrow('boom');
  });

  it('settle waits for in-flight tasks without throwing', async () => {
    const runner = createBoundedRunner(2);
    // Gate both tasks so they are BOTH in flight (neither failed yet) before we
    // submit — otherwise the second submit would fail-fast on the first's error.
    const g1 = deferred();
    const g2 = deferred();
    let done = false;
    await runner.submit(async () => {
      await g1.promise;
      throw new Error('boom');
    });
    await runner.submit(async () => {
      await g2.promise;
      done = true;
    });
    g1.resolve(); // task 1 now fails
    g2.resolve(); // task 2 now completes
    await expect(runner.settle()).resolves.toBeUndefined();
    expect(done).toBe(true);
  });
});
