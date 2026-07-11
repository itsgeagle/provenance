import { describe, it, expect, vi } from 'vitest';
import { parseMode, runMode } from './run-mode.js';

describe('parseMode', () => {
  it('defaults to api when no --mode flag is present', () => {
    expect(parseMode([])).toBe('api');
    expect(parseMode(['watch', 'src/index.ts'])).toBe('api');
  });

  it('reads the --mode value', () => {
    expect(parseMode(['--mode=worker'])).toBe('worker');
    expect(parseMode(['--mode=all'])).toBe('all');
  });

  it('last --mode wins, so a CLI override beats a script default', () => {
    // `npm run dev` injects --mode=all; `-- --mode=api` is appended after it.
    expect(parseMode(['--mode=all', '--mode=api'])).toBe('api');
  });
});

describe('runMode', () => {
  function makeDeps() {
    const teardown = vi.fn(async () => {});
    const stopBoss = vi.fn(async () => {});
    return {
      teardown,
      stopBoss,
      deps: {
        startApi: vi.fn(),
        startWorker: vi.fn(async () => teardown),
        stopBoss,
      },
    };
  }

  // The API enqueues jobs via the lazily-started pg-boss singleton, so api mode
  // must return a teardown that drains it on shutdown (stopBoss is a no-op if
  // the boss was never started).
  it('api mode starts only the API and returns a teardown that drains the boss', async () => {
    const { deps, stopBoss, teardown } = makeDeps();
    const td = await runMode('api', deps);
    expect(deps.startApi).toHaveBeenCalledTimes(1);
    expect(deps.startWorker).not.toHaveBeenCalled();
    expect(td).not.toBeNull();
    expect(td).not.toBe(teardown); // not the worker teardown
    await td!();
    expect(stopBoss).toHaveBeenCalledTimes(1);
  });

  it('worker mode starts only the worker and returns its teardown', async () => {
    const { deps, teardown } = makeDeps();
    const td = await runMode('worker', deps);
    expect(deps.startApi).not.toHaveBeenCalled();
    expect(deps.startWorker).toHaveBeenCalledTimes(1);
    expect(td).toBe(teardown);
  });

  it('all mode starts BOTH the API and the worker in one process', async () => {
    const { deps, teardown } = makeDeps();
    const td = await runMode('all', deps);
    expect(deps.startApi).toHaveBeenCalledTimes(1);
    expect(deps.startWorker).toHaveBeenCalledTimes(1);
    expect(td).toBe(teardown);
  });

  it('throws on an unknown mode', async () => {
    const { deps } = makeDeps();
    await expect(runMode('bogus', deps)).rejects.toThrow(/Unknown --mode/);
    expect(deps.startApi).not.toHaveBeenCalled();
    expect(deps.startWorker).not.toHaveBeenCalled();
  });
});
