/**
 * EventDetail — shows full event JSON + metadata + surrounding event navigation.
 *
 * PRD §7.2 ("Raw timeline").
 *
 * Layout:
 * 1. Metadata header (session id, seq, globalIdx, wall, t, kind).
 * 2. Pretty-printed JSON of the full payload.
 * 3. "Surrounding events" section (prev/next globalIdx, clickable).
 *
 * If no event is selected, shows a placeholder message.
 */

import { ScrollArea } from '@/components/ui/scroll-area.js';
import { Button } from '@/components/ui/button.js';
import { Separator } from '@/components/ui/separator.js';
import type { IndexedEvent } from '../../index/event-index.js';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface EventDetailProps {
  event: IndexedEvent | null;
  /** All ordered events (needed for surrounding event navigation). */
  allEvents: IndexedEvent[];
  /** Called when user clicks a surrounding event — list should scroll there. */
  onNavigate: (event: IndexedEvent) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatWallFull(wall: string): string {
  try {
    return new Date(wall).toLocaleString(undefined, {
      dateStyle: 'short',
      timeStyle: 'medium',
    });
  } catch {
    return wall;
  }
}

// ---------------------------------------------------------------------------
// Surrounding event row
// ---------------------------------------------------------------------------

function SurroundingRow({
  label,
  event,
  onNavigate,
}: {
  label: string;
  event: IndexedEvent;
  onNavigate: (e: IndexedEvent) => void;
}) {
  return (
    <div className="flex items-center justify-between rounded-md border px-3 py-1.5 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono text-muted-foreground">
        #{event.seq} · {event.kind}
      </span>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 text-xs"
        onClick={() => onNavigate(event)}
        data-testid={`navigate-to-${event.globalIdx}`}
      >
        Go
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// EventDetail
// ---------------------------------------------------------------------------

export function EventDetail({ event, allEvents, onNavigate }: EventDetailProps) {
  if (!event) {
    return (
      <div
        className="flex h-full items-center justify-center rounded-md border text-sm text-muted-foreground"
        data-testid="event-detail-placeholder"
      >
        Select an event from the list to see details.
      </div>
    );
  }

  const prevEvent = event.globalIdx > 0 ? (allEvents[event.globalIdx - 1] ?? null) : null;
  const nextEvent =
    event.globalIdx < allEvents.length - 1 ? (allEvents[event.globalIdx + 1] ?? null) : null;

  return (
    <div className="flex h-full flex-col rounded-md border" data-testid="event-detail">
      {/* Metadata header */}
      <div className="shrink-0 space-y-1 border-b px-4 py-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Event Detail
          </span>
          <span
            className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
            data-testid="detail-kind"
          >
            {event.kind}
          </span>
        </div>
        <dl className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs">
          <dt className="text-muted-foreground">Session</dt>
          <dd
            className="truncate font-mono text-foreground"
            title={event.sessionId}
            data-testid="detail-session-id"
          >
            {event.sessionId}
          </dd>
          <dt className="text-muted-foreground">Seq (local)</dt>
          <dd className="font-mono" data-testid="detail-seq">
            #{event.seq}
          </dd>
          <dt className="text-muted-foreground">Global idx</dt>
          <dd className="font-mono" data-testid="detail-global-idx">
            {event.globalIdx}
          </dd>
          <dt className="text-muted-foreground">Wall</dt>
          <dd className="font-mono" data-testid="detail-wall">
            {formatWallFull(event.wall)}
          </dd>
          <dt className="text-muted-foreground">t (ms)</dt>
          <dd className="font-mono" data-testid="detail-t">
            {event.t}
          </dd>
          {event.file && (
            <>
              <dt className="text-muted-foreground">File</dt>
              <dd className="truncate font-mono" title={event.file} data-testid="detail-file">
                {event.file}
              </dd>
            </>
          )}
        </dl>
      </div>

      {/* JSON payload */}
      <ScrollArea className="flex-1">
        <div className="px-4 py-3">
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Payload
          </p>
          <pre
            className="overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-xs font-mono leading-relaxed"
            data-testid="event-json"
          >
            {JSON.stringify(event.payload, null, 2)}
          </pre>
        </div>

        {/* Surrounding events */}
        {(prevEvent !== null || nextEvent !== null) && (
          <div className="px-4 pb-4">
            <Separator className="mb-3" />
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Surrounding events
            </p>
            <div className="space-y-1.5">
              {prevEvent && (
                <SurroundingRow label="Previous" event={prevEvent} onNavigate={onNavigate} />
              )}
              {nextEvent && (
                <SurroundingRow label="Next" event={nextEvent} onNavigate={onNavigate} />
              )}
            </div>
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
