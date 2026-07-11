import { describe, it, expect, vi } from 'vitest';
import { handleFatal } from './fatal.js';
import type { Notifier, NotifyEvent } from './types.js';

function fakeNotifier(): Notifier & { events: NotifyEvent[]; flushCalls: number } {
  const events: NotifyEvent[] = [];
  let flushCalls = 0;
  return {
    events,
    get flushCalls() {
      return flushCalls;
    },
    notify(e: NotifyEvent): void {
      events.push(e);
    },
    async flush(): Promise<void> {
      flushCalls += 1;
    },
  };
}

describe('handleFatal', () => {
  it('notifies a critical process.crash event with the error message and calls flush', async () => {
    const notifier = fakeNotifier();
    await handleFatal(new Error('boom'), notifier);

    expect(notifier.events).toHaveLength(1);
    const [event] = notifier.events;
    expect(event).toBeDefined();
    expect(event?.severity).toBe('critical');
    expect(event?.kind).toBe('process.crash');
    expect(event?.detail?.message).toBe('boom');
    expect(notifier.flushCalls).toBe(1);
  });

  it('includes the stack in detail when available', async () => {
    const notifier = fakeNotifier();
    const err = new Error('boom');
    await handleFatal(err, notifier);
    expect(notifier.events[0]?.detail?.stack).toBe(err.stack);
  });

  it('handles a non-Error thrown value without throwing itself', async () => {
    const notifier = fakeNotifier();
    await expect(handleFatal('a string error', notifier)).resolves.toBeUndefined();
    expect(notifier.events).toHaveLength(1);
    expect(notifier.events[0]?.detail?.message).toBe('a string error');
  });

  it('does not itself throw even if notify throws synchronously', async () => {
    const notifier: Notifier = {
      notify: () => {
        throw new Error('notify blew up');
      },
      flush: vi.fn(async () => {}),
    };
    await expect(handleFatal(new Error('boom'), notifier)).resolves.toBeUndefined();
  });

  it('does not itself throw even if flush rejects', async () => {
    const notifier: Notifier = {
      notify: vi.fn(),
      flush: vi.fn(async () => {
        throw new Error('flush blew up');
      }),
    };
    await expect(handleFatal(new Error('boom'), notifier)).resolves.toBeUndefined();
  });

  it('does not hang if flush never resolves (bounded by timeout)', async () => {
    vi.useFakeTimers();
    try {
      const notifier: Notifier = {
        notify: vi.fn(),
        flush: () => new Promise(() => {}), // never resolves
      };
      const promise = handleFatal(new Error('boom'), notifier);
      await vi.advanceTimersByTimeAsync(2000);
      await expect(promise).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
