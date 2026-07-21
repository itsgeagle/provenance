/**
 * TimelineInner — route-agnostic raw timeline: filter bar + virtualized event
 * list + detail pane.
 *
 * PRD §7.2 ("Raw timeline").
 *
 * Mounted by two routes against two different sources of the same EventIndex:
 *   - /local          → BundleContext (parsed in-browser from a .zip)
 *   - ?tab=timeline   → useFullEventIndex (paged from the server API)
 *
 * Layout: filter bar on top (full width), event list on left (col-span-3),
 * event detail panel on right (col-span-2).
 *
 * Deep-link: ?seq=sessionId:42 selects + scrolls to matching event. Both routes
 * are search-param based, so that handling lives here rather than in the
 * wrappers.
 */

import { useState, useMemo, useCallback, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { EventIndex, IndexedEvent } from '@provenance/analysis-core/index/event-index.js';
import type { EventKind } from '@provenance/log-core';
import { DEFAULT_FILTERS, useFilteredEvents, type TimelineFilters } from './useFilteredEvents.js';
import { FilterBar } from './FilterBar.js';
import { EventList } from './EventList.js';
import { EventDetail } from './EventDetail.js';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

type TimelineInnerProps = {
  /** The whole-bundle event index. `null` renders the empty state. */
  index: EventIndex | null;
  /**
   * Navigate to the replay view at this event. Route-dependent, so it is
   * supplied by the wrapper. Omitted → no per-row replay button.
   */
  onJumpToReplay?: ((event: IndexedEvent) => void) | undefined;
};

// ---------------------------------------------------------------------------
// TimelineInner
// ---------------------------------------------------------------------------

export function TimelineInner({ index, onJumpToReplay }: TimelineInnerProps) {
  const [searchParams] = useSearchParams();

  const [filters, setFilters] = useState<TimelineFilters>(DEFAULT_FILTERS);
  const [selectedEvent, setSelectedEvent] = useState<IndexedEvent | null>(null);
  // scrollToKey drives the EventList's useEffect; reset after consumed.
  const [scrollToKey, setScrollToKey] = useState<string | null>(null);

  // Memoized so the `null` case doesn't hand a fresh [] to every useMemo below
  // on each render.
  const allEvents = useMemo<IndexedEvent[]>(() => index?.ordered ?? [], [index]);

  // Derived: available kinds / files / sessions from the full ordered list.
  const availableKinds = useMemo<EventKind[]>(() => {
    const kinds = new Set<EventKind>();
    for (const e of allEvents) kinds.add(e.kind);
    return Array.from(kinds).sort() as EventKind[];
  }, [allEvents]);

  const availableFiles = useMemo<string[]>(() => {
    const files = new Set<string>();
    for (const e of allEvents) {
      if (e.file) files.add(e.file);
    }
    return Array.from(files).sort();
  }, [allEvents]);

  const availableSessions = useMemo<string[]>(() => {
    const sids = new Set<string>();
    for (const e of allEvents) sids.add(e.sessionId);
    return Array.from(sids);
  }, [allEvents]);

  // Filtered events (memoized).
  const filteredEvents = useFilteredEvents(allEvents, filters);

  // Deep-link: ?seq=sessionId:42
  const seqParam = searchParams.get('seq');
  useEffect(() => {
    if (!seqParam) return;
    const colonIdx = seqParam.lastIndexOf(':');
    if (colonIdx === -1) return;
    const sessionId = seqParam.slice(0, colonIdx);
    const seq = parseInt(seqParam.slice(colonIdx + 1), 10);
    if (isNaN(seq)) return;

    const target = allEvents.find((e) => e.sessionId === sessionId && e.seq === seq);
    if (!target) return;

    setSelectedEvent(target);
    setScrollToKey(seqParam);

    // If the target event is currently filtered out, reset filters so it's visible.
    const isVisible = filteredEvents.some((e) => e.sessionId === sessionId && e.seq === seq);
    if (!isVisible) {
      setFilters(DEFAULT_FILTERS);
    }
    // Intentionally only depends on seqParam: this effect handles URL→view
    // syncing on initial navigation / explicit URL change. Re-firing when
    // allEvents or filteredEvents change would re-scroll the user back to the
    // deep-linked event whenever they applied an unrelated filter.
  }, [seqParam]);

  const handleSelect = useCallback((event: IndexedEvent) => {
    setSelectedEvent(event);
    setScrollToKey(`${event.sessionId}:${event.seq}`);
  }, []);

  // Surrounding event navigation from EventDetail.
  const handleNavigate = useCallback((event: IndexedEvent) => {
    setSelectedEvent(event);
    setScrollToKey(`${event.sessionId}:${event.seq}`);
  }, []);

  const selectedKey = selectedEvent ? `${selectedEvent.sessionId}:${selectedEvent.seq}` : null;

  return (
    <div className="container mx-auto space-y-4 py-4" data-testid="timeline-view">
      {/* Filter bar */}
      <FilterBar
        filters={filters}
        onChange={setFilters}
        availableKinds={availableKinds}
        availableFiles={availableFiles}
        availableSessions={availableSessions}
      />

      {/* Event count label */}
      <p className="text-xs text-muted-foreground" data-testid="event-count-label">
        {filteredEvents.length === allEvents.length
          ? `${allEvents.length} events`
          : `${filteredEvents.length} of ${allEvents.length} events`}
      </p>

      {/* Main grid: list (3/5) + detail (2/5) */}
      <div
        className="grid grid-cols-5 gap-4"
        style={{ height: 'calc(100vh - 200px)' }}
        data-testid="timeline-grid"
      >
        <div className="col-span-3 min-h-0">
          <EventList
            events={filteredEvents}
            onSelect={handleSelect}
            selectedKey={selectedKey}
            scrollToKey={scrollToKey}
            onJumpToReplay={onJumpToReplay}
          />
        </div>
        <div className="col-span-2 min-h-0">
          <EventDetail event={selectedEvent} allEvents={allEvents} onNavigate={handleNavigate} />
        </div>
      </div>
    </div>
  );
}
