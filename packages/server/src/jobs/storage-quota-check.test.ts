import { describe, it, expect, vi } from 'vitest';
import { runStorageQuotaCheck, createStorageQuotaCheckHandler } from './storage-quota-check.js';
import type { Notifier, NotifyEvent } from '../notify/types.js';

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

describe('runStorageQuotaCheck', () => {
  it('notifies warn at 85% usage and sets the gauge', async () => {
    const notifier = fakeNotifier();
    const setGauge = vi.fn();
    const measure = vi.fn(async () => 850);

    const result = await runStorageQuotaCheck({
      root: '/data',
      quotaBytes: 1000,
      warnPct: 80,
      criticalPct: 90,
      measure,
      notifier,
      setGauge,
    });

    expect(result).toEqual({ usedBytes: 850, pct: 85 });
    expect(setGauge).toHaveBeenCalledWith(850, 1000);
    expect(notifier.events).toHaveLength(1);
    expect(notifier.events[0]).toMatchObject({
      severity: 'warn',
      kind: 'storage.quota_warn',
      dedupeKey: 'storage.quota_warn',
    });
  });

  it('notifies critical at 95% usage and sets the gauge', async () => {
    const notifier = fakeNotifier();
    const setGauge = vi.fn();
    const measure = vi.fn(async () => 950);

    const result = await runStorageQuotaCheck({
      root: '/data',
      quotaBytes: 1000,
      warnPct: 80,
      criticalPct: 90,
      measure,
      notifier,
      setGauge,
    });

    expect(result).toEqual({ usedBytes: 950, pct: 95 });
    expect(setGauge).toHaveBeenCalledWith(950, 1000);
    expect(notifier.events).toHaveLength(1);
    expect(notifier.events[0]).toMatchObject({
      severity: 'critical',
      kind: 'storage.quota_critical',
      dedupeKey: 'storage.quota_critical',
    });
  });

  it('does not notify at 50% usage but still sets the gauge', async () => {
    const notifier = fakeNotifier();
    const setGauge = vi.fn();
    const measure = vi.fn(async () => 500);

    const result = await runStorageQuotaCheck({
      root: '/data',
      quotaBytes: 1000,
      warnPct: 80,
      criticalPct: 90,
      measure,
      notifier,
      setGauge,
    });

    expect(result).toEqual({ usedBytes: 500, pct: 50 });
    expect(setGauge).toHaveBeenCalledWith(500, 1000);
    expect(notifier.events).toHaveLength(0);
  });

  it('warns at exactly warnPct (pct === warnPct, boundary)', async () => {
    const notifier = fakeNotifier();
    const setGauge = vi.fn();
    const measure = vi.fn(async () => 800);

    const result = await runStorageQuotaCheck({
      root: '/data',
      quotaBytes: 1000,
      warnPct: 80,
      criticalPct: 90,
      measure,
      notifier,
      setGauge,
    });

    expect(result).toEqual({ usedBytes: 800, pct: 80 });
    expect(notifier.events).toHaveLength(1);
    expect(notifier.events[0]).toMatchObject({
      severity: 'warn',
      kind: 'storage.quota_warn',
    });
  });

  it('criticals at exactly criticalPct (pct === criticalPct, boundary)', async () => {
    const notifier = fakeNotifier();
    const setGauge = vi.fn();
    const measure = vi.fn(async () => 900);

    const result = await runStorageQuotaCheck({
      root: '/data',
      quotaBytes: 1000,
      warnPct: 80,
      criticalPct: 90,
      measure,
      notifier,
      setGauge,
    });

    expect(result).toEqual({ usedBytes: 900, pct: 90 });
    expect(notifier.events).toHaveLength(1);
    expect(notifier.events[0]).toMatchObject({
      severity: 'critical',
      kind: 'storage.quota_critical',
    });
  });

  it('passes root through to measure', async () => {
    const notifier = fakeNotifier();
    const setGauge = vi.fn();
    const measure = vi.fn(async () => 0);

    await runStorageQuotaCheck({
      root: '/srv/provenance/blobs',
      quotaBytes: 1000,
      warnPct: 80,
      criticalPct: 90,
      measure,
      notifier,
      setGauge,
    });

    expect(measure).toHaveBeenCalledWith('/srv/provenance/blobs');
  });
});

describe('createStorageQuotaCheckHandler', () => {
  it('is a no-op for the s3 backend (does not measure or notify)', async () => {
    const handler = createStorageQuotaCheckHandler({
      root: '',
      quotaBytes: 1000,
      warnPct: 80,
      criticalPct: 90,
      backend: 's3',
    });

    // Should resolve without throwing even though root is invalid for statfs.
    await expect(handler()).resolves.toBeUndefined();
  });
});
