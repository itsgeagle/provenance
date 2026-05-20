/**
 * EventSidebar — virtualized event log for the replay view.
 *
 * Auto-scrolls to keep the current event (currentGlobalIdx) visible as the
 * engine advances. Clicking a row calls `onSeek(event.globalIdx)`.
 *
 * Design:
 *   - Uses @tanstack/react-virtual (already a dep from Phase 7's EventList).
 *   - Row format is a one-liner: `#seq kind file? summary` — narrower than
 *     the full timeline EventList (which has wall time + session chip).
 *   - Auto-scroll: when `currentGlobalIdx` changes, scroll to that index with
 *     align='center'. We track the last auto-scrolled index to avoid fighting
 *     the user's manual scroll (only re-scroll if the current event has moved).
 *   - Each row highlights when it matches `currentGlobalIdx`.
 *
 * PRD ref: §7.2 (scrolling sidebar event log).
 */

import { useRef, useEffect, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { cn } from '@/lib/utils';
import type { IndexedEvent } from '../../index/event-index.js';
import type { EventKind } from '@provenance/log-core';

// ---------------------------------------------------------------------------
// Row height (narrower than EventList; 30px)
// ---------------------------------------------------------------------------

const ROW_HEIGHT = 30;

// ---------------------------------------------------------------------------
// Kind chip (compact)
// ---------------------------------------------------------------------------

const KIND_CHIP_CLASSES: Partial<Record<EventKind, string>> = {
  paste: 'bg-orange-100 text-orange-700',
  'paste.anomaly': 'bg-orange-100 text-orange-700',
  'fs.external_change': 'bg-red-100 text-red-700',
  'chain.broken': 'bg-red-100 text-red-700',
  'session.start': 'bg-blue-100 text-blue-700',
  'session.end': 'bg-blue-100 text-blue-700',
  'terminal.command': 'bg-purple-100 text-purple-700',
};

const DEFAULT_KIND_CHIP = 'bg-gray-100 text-gray-600';

/**
 * Determine the chip style + label for an event. Recorder v1.2 marks
 * paste-shaped bulk edits as `doc.change` with `source: 'paste_likely' |
 * 'paste_confirmed'` (PRD §4.3); render those with the paste color and a
 * trailing asterisk so they're visually grouped with native paste events.
 */
function chipFor(event: IndexedEvent): { className: string; label: string } {
  if (event.kind === 'doc.change') {
    const payload = event.payload as Record<string, unknown> | null;
    const source =
      payload !== null && typeof payload['source'] === 'string'
        ? (payload['source'] as string)
        : 'typed';
    if (source === 'paste_likely' || source === 'paste_confirmed') {
      return { className: KIND_CHIP_CLASSES.paste!, label: 'paste*' };
    }
  }
  return {
    className: KIND_CHIP_CLASSES[event.kind] ?? DEFAULT_KIND_CHIP,
    label: event.kind,
  };
}

function SidebarKindChip({ event }: { event: IndexedEvent }) {
  const { className, label } = chipFor(event);
  return (
    <span
      className={cn('shrink-0 rounded px-1 py-0.5 font-mono text-[9px] font-medium', className)}
      title={
        label === 'paste*'
          ? 'paste-shaped doc.change (recorder v1.2 broadened paste classifier — multi-delta or replacement edit)'
          : undefined
      }
    >
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Sidebar row
// ---------------------------------------------------------------------------

interface SidebarRowProps {
  event: IndexedEvent;
  isCurrent: boolean;
  onSeek: (globalIdx: number) => void;
  style: React.CSSProperties;
}

function SidebarRow({ event, isCurrent, onSeek, style }: SidebarRowProps) {
  const filePart = event.file ? (event.file.split('/').pop() ?? event.file) : '';

  return (
    <div
      style={style}
      role="button"
      tabIndex={0}
      className={cn(
        'absolute left-0 right-0 flex cursor-pointer items-center gap-1.5 border-b px-2 text-[11px] transition-colors hover:bg-accent/50 focus:outline-none focus:ring-1 focus:ring-ring',
        isCurrent && 'bg-accent font-medium',
      )}
      onClick={() => onSeek(event.globalIdx)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSeek(event.globalIdx);
        }
      }}
      data-testid={`sidebar-row-${event.globalIdx}`}
      data-global-idx={event.globalIdx}
      aria-current={isCurrent ? 'step' : undefined}
    >
      {/* seq */}
      <span className="w-10 shrink-0 font-mono text-muted-foreground">#{event.seq}</span>

      {/* kind chip */}
      <SidebarKindChip event={event} />

      {/* file (basename only) */}
      {filePart && (
        <span className="min-w-0 truncate font-mono text-muted-foreground" title={event.file}>
          {filePart}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// EventSidebar
// ---------------------------------------------------------------------------

interface EventSidebarProps {
  /** All events in the session (in chronological order). */
  events: IndexedEvent[];
  /** The engine's current position (globalIdx of the current event). */
  currentGlobalIdx: number;
  /** Seek the engine to this globalIdx. */
  onSeek: (globalIdx: number) => void;
}

export function EventSidebar({ events, currentGlobalIdx, onSeek }: EventSidebarProps) {
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: events.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });

  // Auto-scroll: keep the current event in view when currentGlobalIdx changes.
  // We track the last value we scrolled to so we don't fight user scroll.
  const lastScrolledIdx = useRef<number>(-2); // -2 to force initial scroll

  const handleSeek = useCallback(
    (globalIdx: number) => {
      onSeek(globalIdx);
    },
    [onSeek],
  );

  useEffect(() => {
    if (currentGlobalIdx === lastScrolledIdx.current) return;
    // Find the position of currentGlobalIdx in the events array.
    // events[i].globalIdx is NOT necessarily i (the sidebar shows session events,
    // which may start at a non-zero globalIdx). Do a linear scan.
    // For perf: if the session is long and this becomes slow, memoize a
    // globalIdx→listIdx map. For Phase 14 this is fine.
    const listIdx = events.findIndex((e) => e.globalIdx === currentGlobalIdx);
    if (listIdx !== -1) {
      virtualizer.scrollToIndex(listIdx, { align: 'center' });
      lastScrolledIdx.current = currentGlobalIdx;
    }
  }, [currentGlobalIdx, events, virtualizer]);

  const totalSize = virtualizer.getTotalSize();
  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div
      className="flex h-full flex-col overflow-hidden border-l bg-background"
      data-testid="event-sidebar"
    >
      {/* Header */}
      <div className="shrink-0 border-b bg-muted/50 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        Events
      </div>

      {/* Empty state */}
      {events.length === 0 && (
        <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
          No events
        </div>
      )}

      {/* Virtualized list */}
      {events.length > 0 && (
        <div
          ref={parentRef}
          className="flex-1 overflow-auto"
          data-testid="sidebar-virtual-container"
        >
          <div style={{ height: totalSize, width: '100%', position: 'relative' }}>
            {virtualItems.map((virtualItem) => {
              const event = events[virtualItem.index]!;
              return (
                <SidebarRow
                  key={virtualItem.key}
                  event={event}
                  isCurrent={event.globalIdx === currentGlobalIdx}
                  onSeek={handleSeek}
                  style={{
                    height: virtualItem.size,
                    transform: `translateY(${virtualItem.start}px)`,
                  }}
                />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
