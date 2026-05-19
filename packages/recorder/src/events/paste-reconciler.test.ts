import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startPasteReconciler } from './paste-reconciler.js';
import type { PasteAnomalyPayload } from '@provenance/log-core';

describe('startPasteReconciler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeCounters(initial = { intercepted: 0, largeInsert: 0 }) {
    const state = { ...initial };
    return {
      getInterceptedCount: () => state.intercepted,
      getLargeInsertCount: () => state.largeInsert,
      setIntercepted: (n: number) => {
        state.intercepted = n;
      },
      setLargeInsert: (n: number) => {
        state.largeInsert = n;
      },
      increment: (field: 'intercepted' | 'largeInsert', by = 1) => {
        state[field] += by;
      },
    };
  }

  it('does NOT emit when counts are equal after an interval', () => {
    const counters = makeCounters();
    const emit = vi.fn();
    startPasteReconciler({
      intervalMs: 1000,
      toleranceWindow: 1,
      emit,
      getInterceptedCount: counters.getInterceptedCount,
      getLargeInsertCount: counters.getLargeInsertCount,
    });

    counters.setIntercepted(3);
    counters.setLargeInsert(3);
    vi.advanceTimersByTime(1000);

    expect(emit).not.toHaveBeenCalled();
  });

  it('does NOT emit when discrepancy is within tolerance (|diff| <= toleranceWindow)', () => {
    const counters = makeCounters();
    const emit = vi.fn();
    startPasteReconciler({
      intervalMs: 1000,
      toleranceWindow: 1,
      emit,
      getInterceptedCount: counters.getInterceptedCount,
      getLargeInsertCount: counters.getLargeInsertCount,
    });

    // |2 - 3| == 1, which is NOT > toleranceWindow(1)
    counters.setIntercepted(2);
    counters.setLargeInsert(3);
    vi.advanceTimersByTime(1000);

    expect(emit).not.toHaveBeenCalled();
  });

  it('emits with correct counts when discrepancy exceeds tolerance', () => {
    const counters = makeCounters();
    const emit = vi.fn();
    startPasteReconciler({
      intervalMs: 1000,
      toleranceWindow: 1,
      emit,
      getInterceptedCount: counters.getInterceptedCount,
      getLargeInsertCount: counters.getLargeInsertCount,
    });

    // |1 - 4| == 3, which is > toleranceWindow(1)
    counters.setIntercepted(1);
    counters.setLargeInsert(4);
    vi.advanceTimersByTime(1000);

    expect(emit).toHaveBeenCalledOnce();
    const payload = emit.mock.calls[0]![0] as PasteAnomalyPayload;
    expect(payload.intercepted_count).toBe(1);
    expect(payload.large_insert_count).toBe(4);
  });

  it('uses delta (incremental) counts, not cumulative', () => {
    const counters = makeCounters();
    const emit = vi.fn();
    startPasteReconciler({
      intervalMs: 1000,
      toleranceWindow: 0,
      emit,
      getInterceptedCount: counters.getInterceptedCount,
      getLargeInsertCount: counters.getLargeInsertCount,
    });

    // First interval: 5 vs 5 — equal, no emit
    counters.setIntercepted(5);
    counters.setLargeInsert(5);
    vi.advanceTimersByTime(1000);
    expect(emit).not.toHaveBeenCalled();

    // Second interval: +2 vs +3 — delta is 2 vs 3, discrepancy=1 > tolerance=0
    counters.setIntercepted(7);
    counters.setLargeInsert(8);
    vi.advanceTimersByTime(1000);
    expect(emit).toHaveBeenCalledOnce();
    const payload = emit.mock.calls[0]![0] as PasteAnomalyPayload;
    expect(payload.intercepted_count).toBe(2);
    expect(payload.large_insert_count).toBe(3);
  });

  it('next interval after emit uses NEW baseline (not cumulative)', () => {
    const counters = makeCounters();
    const emit = vi.fn();
    startPasteReconciler({
      intervalMs: 1000,
      toleranceWindow: 0,
      emit,
      getInterceptedCount: counters.getInterceptedCount,
      getLargeInsertCount: counters.getLargeInsertCount,
    });

    // First interval: mismatched, emits
    counters.setIntercepted(1);
    counters.setLargeInsert(5);
    vi.advanceTimersByTime(1000);
    expect(emit).toHaveBeenCalledOnce();

    // Second interval: equal deltas from NEW baseline — no emit
    counters.setIntercepted(3);
    counters.setLargeInsert(7);
    vi.advanceTimersByTime(1000);
    // delta: +2 vs +2 — equal
    expect(emit).toHaveBeenCalledOnce(); // still only 1 call
  });

  it('disposable clears the interval', () => {
    const counters = makeCounters();
    const emit = vi.fn();
    const disposable = startPasteReconciler({
      intervalMs: 1000,
      toleranceWindow: 0,
      emit,
      getInterceptedCount: counters.getInterceptedCount,
      getLargeInsertCount: counters.getLargeInsertCount,
    });

    disposable.dispose();

    // After dispose, advancing time should not trigger any callbacks
    counters.setIntercepted(0);
    counters.setLargeInsert(10);
    vi.advanceTimersByTime(5000);
    expect(emit).not.toHaveBeenCalled();
  });

  it('uses default intervalMs=5000 when not specified', () => {
    const counters = makeCounters();
    const emit = vi.fn();
    startPasteReconciler({
      emit,
      getInterceptedCount: counters.getInterceptedCount,
      getLargeInsertCount: counters.getLargeInsertCount,
    });

    counters.setIntercepted(0);
    counters.setLargeInsert(10);

    vi.advanceTimersByTime(4999);
    expect(emit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(emit).toHaveBeenCalledOnce();
  });
});
