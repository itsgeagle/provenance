/**
 * storage-quota-check — hourly cron.
 *
 * The apphost storage mount (`BLOB_STORAGE_FS_ROOT`) has a hard quota with
 * zero headroom past it: writes start failing once it's full. This job
 * measures current usage, updates a Prometheus gauge unconditionally (so
 * `/metrics` always reflects the latest check), and notifies via the
 * operational notifier (Feature 1) when usage crosses the warn/critical
 * thresholds:
 *
 *   pct >= criticalPct -> severity 'critical', kind 'storage.quota_critical'
 *   pct >= warnPct     -> severity 'warn',     kind 'storage.quota_warn'
 *   otherwise          -> no notification
 *
 * `dedupeKey` is fixed per level ('storage.quota_warn' / 'storage.quota_critical')
 * rather than per-check, giving each severity a stable identity in the
 * notifier's throttle. Note the throttle window (ALERT_DEDUPE_WINDOW_SECONDS,
 * default 300s) is shorter than this cron's cadence (hourly, 3600s), so the
 * window has always elapsed by the next run: a still-breached threshold
 * re-alerts every hour. That is intended — a recurring hourly reminder until
 * the storage situation is fixed, not a one-shot page. The dedupeKey's job
 * here is de-duping bursts (e.g. a manual re-run within the window), not
 * suppressing the hourly reminder.
 *
 * No-op under the s3 backend: there is no local mount to statfs, and the
 * quota concern is entirely an fs-backend (NFS mount) problem.
 */

import type { Notifier } from '../notify/types.js';
import { measureUsedBytes } from '../services/storage/usage.js';
import { setStorageGauge } from '../api/middleware/metrics.js';
import { getNotifier } from '../notify/notifier.js';
import { getLogger } from '../logging.js';

// ---------------------------------------------------------------------------
// Pure check
// ---------------------------------------------------------------------------

export interface StorageQuotaCheckDeps {
  root: string;
  quotaBytes: number;
  warnPct: number;
  criticalPct: number;
  measure: (root: string) => Promise<number>;
  notifier: Notifier;
  setGauge: (used: number, quota: number) => void;
}

export interface StorageQuotaCheckResult {
  usedBytes: number;
  pct: number;
}

/**
 * Measures usage, updates the gauge (always), and notifies at the
 * appropriate severity when a threshold is crossed. Never throws for a
 * threshold crossing — notification failures are handled by the notifier
 * itself (notify() never throws, per its contract).
 */
export async function runStorageQuotaCheck(
  deps: StorageQuotaCheckDeps,
): Promise<StorageQuotaCheckResult> {
  const usedBytes = await deps.measure(deps.root);
  const pct = (usedBytes / deps.quotaBytes) * 100;

  deps.setGauge(usedBytes, deps.quotaBytes);

  if (pct >= deps.criticalPct) {
    deps.notifier.notify({
      severity: 'critical',
      kind: 'storage.quota_critical',
      title: `Storage usage at ${pct.toFixed(1)}% of quota`,
      detail: { usedBytes, quotaBytes: deps.quotaBytes, pct },
      dedupeKey: 'storage.quota_critical',
    });
  } else if (pct >= deps.warnPct) {
    deps.notifier.notify({
      severity: 'warn',
      kind: 'storage.quota_warn',
      title: `Storage usage at ${pct.toFixed(1)}% of quota`,
      detail: { usedBytes, quotaBytes: deps.quotaBytes, pct },
      dedupeKey: 'storage.quota_warn',
    });
  }

  return { usedBytes, pct };
}

// ---------------------------------------------------------------------------
// pg-boss handler factory
// ---------------------------------------------------------------------------

export interface StorageQuotaCheckHandlerDeps {
  root: string;
  quotaBytes: number;
  warnPct: number;
  criticalPct: number;
  backend: 's3' | 'fs';
}

/**
 * Creates the pg-boss handler for the `storage_quota_check` job. A genuine
 * no-op (no statfs call, no notify) when `backend !== 'fs'` — there is no
 * local mount to measure, and `root` may not even be a valid path in that
 * case (BLOB_STORAGE_FS_ROOT is unset under the s3 backend).
 */
export function createStorageQuotaCheckHandler(
  deps: StorageQuotaCheckHandlerDeps,
): () => Promise<void> {
  return async () => {
    if (deps.backend !== 'fs') {
      return;
    }

    const result = await runStorageQuotaCheck({
      root: deps.root,
      quotaBytes: deps.quotaBytes,
      warnPct: deps.warnPct,
      criticalPct: deps.criticalPct,
      measure: measureUsedBytes,
      notifier: getNotifier(),
      setGauge: setStorageGauge,
    });

    getLogger().info(result, 'storage-quota-check: complete');
  };
}
