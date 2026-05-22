/**
 * Timeline tab — event list with kind/file/session filters.
 *
 * Phase 23. Consumes SubmissionDataProvider via useSubmissionData().
 * A simplified event list (not the full v2 TimelineView with Monaco).
 * Phase 24/25 can integrate deeper with the v2 primitives.
 */

import { useState } from 'react';
import { useSubmissionData } from '../../data/SubmissionDataProvider.js';
import type { EventQueryFilters } from '../../data/SubmissionDataProvider.js';

// ---------------------------------------------------------------------------
// Event kind filter options (most common kinds)
// ---------------------------------------------------------------------------

const COMMON_KINDS = [
  'doc.change',
  'doc.save',
  'doc.open',
  'doc.close',
  'doc.paste',
  'fs.external_change',
  'session.heartbeat',
  'session.start',
  'session.end',
];

// ---------------------------------------------------------------------------
// Event row display
// ---------------------------------------------------------------------------

function eventSummary(kind: string, payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) return '';
  const p = payload as Record<string, unknown>;
  if (kind === 'doc.change' || kind === 'doc.paste') {
    const path = typeof p['path'] === 'string' ? p['path'] : '';
    return path ? `← ${path}` : '';
  }
  if (kind === 'doc.save' || kind === 'doc.open' || kind === 'doc.close') {
    const path = typeof p['path'] === 'string' ? p['path'] : '';
    return path ? `← ${path}` : '';
  }
  return '';
}

function formatWall(wall: string): string {
  try {
    return new Date(wall).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return wall;
  }
}

// ---------------------------------------------------------------------------
// Timeline component
// ---------------------------------------------------------------------------

export function Timeline() {
  const provider = useSubmissionData();

  // Filter state
  const [selectedKinds, setSelectedKinds] = useState<string[]>([]);
  const [fileFilter, setFileFilter] = useState('');

  const filters: EventQueryFilters = {
    ...(selectedKinds.length > 0 ? { kind: selectedKinds } : {}),
    ...(fileFilter ? { file: fileFilter } : {}),
  };

  const eventsQuery = provider.useEvents(filters);

  function toggleKind(kind: string) {
    setSelectedKinds((prev) =>
      prev.includes(kind) ? prev.filter((k) => k !== kind) : [...prev, kind],
    );
  }

  const events = eventsQuery.data ?? [];
  const displayEvents = events.slice(0, 500); // Show first 500 matching events

  return (
    <div className="container mx-auto py-6 space-y-4" data-testid="submission-timeline">
      {/* Filter bar */}
      <section className="bg-white rounded-lg border border-gray-200 p-4">
        <div className="flex flex-wrap gap-2 items-center">
          <span className="text-sm font-medium text-gray-600 mr-1">Filter by kind:</span>
          {COMMON_KINDS.map((kind) => (
            <button
              key={kind}
              onClick={() => toggleKind(kind)}
              className={`text-xs px-2 py-1 rounded border transition-colors ${
                selectedKinds.includes(kind)
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'text-gray-600 border-gray-300 hover:border-blue-400'
              }`}
              data-testid={`kind-filter-${kind.replace('.', '-')}`}
            >
              {kind}
            </button>
          ))}
          {selectedKinds.length > 0 && (
            <button
              onClick={() => setSelectedKinds([])}
              className="text-xs px-2 py-1 text-gray-500 hover:text-gray-700"
              data-testid="clear-kind-filters"
            >
              Clear
            </button>
          )}
        </div>
        <div className="mt-3 flex items-center gap-2">
          <label className="text-sm font-medium text-gray-600">File:</label>
          <input
            type="text"
            value={fileFilter}
            onChange={(e) => setFileFilter(e.target.value)}
            placeholder="e.g. hw1.py"
            className="text-sm border border-gray-300 rounded px-2 py-1 w-48 focus:outline-none focus:ring-1 focus:ring-blue-400"
            data-testid="file-filter-input"
          />
          {fileFilter && (
            <button
              onClick={() => setFileFilter('')}
              className="text-xs text-gray-500 hover:text-gray-700"
              data-testid="clear-file-filter"
            >
              Clear
            </button>
          )}
        </div>
      </section>

      {/* Event list */}
      <section
        className="bg-white rounded-lg border border-gray-200 overflow-hidden"
        data-testid="event-list"
      >
        <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-700">
            {eventsQuery.isLoading ? (
              'Loading events…'
            ) : (
              <>
                {events.length.toLocaleString()} events
                {events.length > displayEvents.length && (
                  <span className="text-gray-400 ml-1">(showing first {displayEvents.length})</span>
                )}
              </>
            )}
          </h2>
        </div>

        {eventsQuery.isLoading && (
          <div className="p-6 text-gray-500 text-sm text-center" data-testid="timeline-loading">
            Loading events…
          </div>
        )}
        {eventsQuery.isError && (
          <div className="p-6 text-red-600 text-sm" data-testid="timeline-error">
            Failed to load events.
          </div>
        )}
        {!eventsQuery.isLoading && !eventsQuery.isError && displayEvents.length === 0 && (
          <div className="p-6 text-gray-400 text-sm text-center" data-testid="timeline-empty">
            No events match the current filters.
          </div>
        )}

        <div className="divide-y divide-gray-50">
          {displayEvents.map((event) => (
            <div
              key={event.seq}
              className="px-4 py-2 flex items-baseline gap-3 text-sm hover:bg-gray-50"
              data-testid={`event-row-${event.seq}`}
            >
              <span className="text-gray-300 font-mono text-xs w-8 shrink-0 text-right">
                {event.seq}
              </span>
              <span className="text-gray-500 font-mono text-xs w-20 shrink-0">
                {formatWall(event.wall)}
              </span>
              <span className="text-blue-700 font-medium text-xs w-40 shrink-0">{event.kind}</span>
              <span className="text-gray-400 text-xs truncate">
                {eventSummary(event.kind, event.payload)}
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
