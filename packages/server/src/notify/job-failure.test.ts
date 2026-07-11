import { describe, it, expect } from 'vitest';
import { withFailureNotification } from './job-failure.js';
import type { Notifier, NotifyEvent } from './types.js';

function fakeNotifier(): Notifier & { events: NotifyEvent[] } {
  const events: NotifyEvent[] = [];
  return {
    events,
    notify(e: NotifyEvent): void {
      events.push(e);
    },
    async flush(): Promise<void> {},
  };
}

interface FakeJob {
  retryCount?: number;
  retryLimit?: number;
}

describe('withFailureNotification', () => {
  it('retries exhausted (retryCount >= retryLimit): notifies once and rethrows', async () => {
    const notifier = fakeNotifier();
    const job: FakeJob = { retryCount: 3, retryLimit: 3 };
    const handler = async (_job: FakeJob): Promise<void> => {
      throw new Error('boom');
    };
    const wrapped = withFailureNotification(
      { kind: 'job.dead_letter', severity: 'warn', notifier },
      handler,
    );

    await expect(wrapped(job)).rejects.toThrow('boom');
    expect(notifier.events).toHaveLength(1);
    expect(notifier.events[0]?.kind).toBe('job.dead_letter');
    expect(notifier.events[0]?.severity).toBe('warn');
    expect(notifier.events[0]?.detail?.retryCount).toBe(3);
    expect(notifier.events[0]?.detail?.error).toBe('boom');
  });

  it('retries remaining (retryCount < retryLimit): does not notify but rethrows', async () => {
    const notifier = fakeNotifier();
    const job: FakeJob = { retryCount: 1, retryLimit: 3 };
    const handler = async (_job: FakeJob): Promise<void> => {
      throw new Error('transient');
    };
    const wrapped = withFailureNotification(
      { kind: 'job.dead_letter', severity: 'warn', notifier },
      handler,
    );

    await expect(wrapped(job)).rejects.toThrow('transient');
    expect(notifier.events).toHaveLength(0);
  });

  it('missing retry fields + throw: treats as exhausted (fail-safe), notifies and rethrows', async () => {
    const notifier = fakeNotifier();
    const job: FakeJob = {}; // no retryCount/retryLimit at all
    const handler = async (_job: FakeJob): Promise<void> => {
      throw new Error('no metadata');
    };
    const wrapped = withFailureNotification(
      { kind: 'job.dead_letter', severity: 'warn', notifier },
      handler,
    );

    await expect(wrapped(job)).rejects.toThrow('no metadata');
    expect(notifier.events).toHaveLength(1);
    expect(notifier.events[0]?.detail?.error).toBe('no metadata');
  });

  it('only retryCount missing (retryLimit present): fail-safe exhausted, notifies and rethrows', async () => {
    const notifier = fakeNotifier();
    const job: FakeJob = { retryLimit: 5 };
    const handler = async (): Promise<void> => {
      throw new Error('partial metadata');
    };
    const wrapped = withFailureNotification(
      { kind: 'job.dead_letter', severity: 'warn', notifier },
      handler,
    );

    await expect(wrapped(job)).rejects.toThrow('partial metadata');
    expect(notifier.events).toHaveLength(1);
  });

  it('handler success: no notify, no throw', async () => {
    const notifier = fakeNotifier();
    const job: FakeJob = { retryCount: 0, retryLimit: 3 };
    const handler = async (_job: FakeJob): Promise<void> => {
      // succeeds
    };
    const wrapped = withFailureNotification(
      { kind: 'job.dead_letter', severity: 'warn', notifier },
      handler,
    );

    await expect(wrapped(job)).resolves.toBeUndefined();
    expect(notifier.events).toHaveLength(0);
  });

  it('rethrows the exact original error object (not wrapped) in the notify branch', async () => {
    const notifier = fakeNotifier();
    const job: FakeJob = { retryCount: 2, retryLimit: 2 };
    const originalError = new Error('exact error');
    const handler = async (): Promise<void> => {
      throw originalError;
    };
    const wrapped = withFailureNotification(
      { kind: 'job.dead_letter', severity: 'warn', notifier },
      handler,
    );

    await expect(wrapped(job)).rejects.toBe(originalError);
  });

  it('rethrows the exact original error object in the no-notify branch', async () => {
    const notifier = fakeNotifier();
    const job: FakeJob = { retryCount: 0, retryLimit: 2 };
    const originalError = new Error('exact error 2');
    const handler = async (): Promise<void> => {
      throw originalError;
    };
    const wrapped = withFailureNotification(
      { kind: 'job.dead_letter', severity: 'warn', notifier },
      handler,
    );

    await expect(wrapped(job)).rejects.toBe(originalError);
    expect(notifier.events).toHaveLength(0);
  });

  it('propagates a thrown non-Error value and still notifies when exhausted', async () => {
    const notifier = fakeNotifier();
    const job: FakeJob = { retryCount: 1, retryLimit: 1 };
    const handler = async (): Promise<void> => {
      throw 'string failure';
    };
    const wrapped = withFailureNotification(
      { kind: 'job.dead_letter', severity: 'warn', notifier },
      handler,
    );

    await expect(wrapped(job)).rejects.toBe('string failure');
    expect(notifier.events[0]?.detail?.error).toBe('string failure');
  });
});
