/**
 * Paste reconciler — signal 3 of three-signal paste detection (PRD §4.3).
 *
 * Compares handler-intercepted paste counts against large-single-insert
 * classification counts on a rolling window. Mismatches (above tolerance)
 * emit paste.anomaly events.
 *
 * Returns a Disposable that clears the interval. The interval is unref'd so
 * it does not block Node.js process exit (CLAUDE.md: "no background tasks
 * without an explicit shutdown path").
 */

import type * as vscode from 'vscode';
import type { PasteAnomalyPayload } from '@provenance/log-core';

export type ReconcilerDeps = {
  /** Interval between reconciliation checks. Default: 5000 ms. */
  intervalMs?: number;
  /**
   * Counts within ±toleranceWindow are not considered anomalous.
   * Default: 1 (small one-off differences are expected due to timing).
   */
  toleranceWindow?: number;
  emit: (data: PasteAnomalyPayload) => void;
  getInterceptedCount: () => number;
  getLargeInsertCount: () => number;
};

/**
 * Start the reconciliation interval.
 * Returns a vscode.Disposable that clears the interval.
 */
export function startPasteReconciler(deps: ReconcilerDeps): vscode.Disposable {
  const {
    intervalMs = 5_000,
    toleranceWindow = 1,
    emit,
    getInterceptedCount,
    getLargeInsertCount,
  } = deps;

  // Capture baseline counts at start
  let lastIntercepted = getInterceptedCount();
  let lastLargeInsert = getLargeInsertCount();

  const timer = setInterval(() => {
    const currentIntercepted = getInterceptedCount();
    const currentLargeInsert = getLargeInsertCount();

    const deltaIntercepted = currentIntercepted - lastIntercepted;
    const deltaLargeInsert = currentLargeInsert - lastLargeInsert;

    // Update baselines unconditionally (whether we emit or not)
    lastIntercepted = currentIntercepted;
    lastLargeInsert = currentLargeInsert;

    const discrepancy = Math.abs(deltaIntercepted - deltaLargeInsert);
    if (discrepancy > toleranceWindow) {
      emit({
        intercepted_count: deltaIntercepted,
        large_insert_count: deltaLargeInsert,
      });
    }
  }, intervalMs);

  // Unref so the timer doesn't keep Node alive after VS Code tries to shut down.
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
    (timer as NodeJS.Timeout).unref();
  }

  return {
    dispose() {
      clearInterval(timer);
    },
  };
}
