/**
 * useFilteredEvents — memoized filter hook for the raw timeline view.
 *
 * PRD §7.2 ("Raw timeline").
 *
 * Takes the full ordered event list and a filter object, returns a filtered
 * slice. Filters are AND-ed: an event must pass every active filter.
 *
 * "No filter" sentinel: empty Set / null boundary → include everything.
 * Consumers can check `filters === DEFAULT_FILTERS` or compare field-by-field;
 * this hook re-memos on any filter field change via JSON.stringify key.
 */

import { useMemo } from 'react';
import type { EventKind } from '@provenance/log-core';
import type { IndexedEvent } from '@provenance/analysis-core/index/event-index.js';

// ---------------------------------------------------------------------------
// Filter type
// ---------------------------------------------------------------------------

export type TimelineFilters = {
  /** Empty set = all kinds (no filter). */
  kinds: Set<EventKind>;
  /** Empty set = all files (no filter). v1: single-select, so at most 1 element. */
  files: Set<string>;
  /** null = unbounded. Uses event.t (ms since session start). */
  timeRangeMs: { start: number | null; end: number | null };
  /** Empty set = all sessions (no filter). */
  sessionIds: Set<string>;
};

export const DEFAULT_FILTERS: TimelineFilters = {
  kinds: new Set(),
  files: new Set(),
  timeRangeMs: { start: null, end: null },
  sessionIds: new Set(),
};

// ---------------------------------------------------------------------------
// Filter predicate (pure function, exported for testing)
// ---------------------------------------------------------------------------

/**
 * Returns true if the event passes all active filters.
 *
 * @param event  - the event to test
 * @param filters - the current filter state
 */
export function eventPassesFilters(event: IndexedEvent, filters: TimelineFilters): boolean {
  // Kind filter
  if (filters.kinds.size > 0 && !filters.kinds.has(event.kind)) {
    return false;
  }

  // File filter
  if (filters.files.size > 0) {
    const eventFile = event.file ?? '';
    if (!filters.files.has(eventFile)) {
      return false;
    }
  }

  // Time range filter (uses event.t — session-local ms since session start)
  if (filters.timeRangeMs.start !== null && event.t < filters.timeRangeMs.start) {
    return false;
  }
  if (filters.timeRangeMs.end !== null && event.t > filters.timeRangeMs.end) {
    return false;
  }

  // Session filter
  if (filters.sessionIds.size > 0 && !filters.sessionIds.has(event.sessionId)) {
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Serialization helper for memo key
// ---------------------------------------------------------------------------

/**
 * Produce a stable string key from a TimelineFilters object.
 * Sets are serialized as sorted arrays so key is deterministic.
 */
function filtersKey(filters: TimelineFilters): string {
  return JSON.stringify({
    kinds: Array.from(filters.kinds).sort(),
    files: Array.from(filters.files).sort(),
    timeRangeMs: filters.timeRangeMs,
    sessionIds: Array.from(filters.sessionIds).sort(),
  });
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * useFilteredEvents — memoized; re-runs when events or filters change.
 *
 * @param events  - full ordered IndexedEvent list (from index.ordered)
 * @param filters - current filter state
 * @returns filtered subset, in the same chronological order
 */
export function useFilteredEvents(
  events: IndexedEvent[],
  filters: TimelineFilters,
): IndexedEvent[] {
  // Memo keyed on filtersKey(filters) so we re-filter on value-change, not
  // reference-change. Filters are reconstructed on every TimelineView render.
  const key = filtersKey(filters);
  return useMemo(
    () => events.filter((e) => eventPassesFilters(e, filters)),
    [events, key, filters],
  );
}
