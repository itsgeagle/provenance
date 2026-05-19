/**
 * EventIndex types (Phase 3).
 *
 * PRD §7.3, §7.4.
 *
 * An EventIndex is the primary in-memory data structure that all downstream
 * views (overview, timeline, heuristics) read from. It is built once per
 * Bundle load by build-index.ts and then treated as immutable.
 */

import type { EventKind } from '@provenance/log-core';

// ---------------------------------------------------------------------------
// IndexedEvent
// ---------------------------------------------------------------------------

/**
 * A single event as it appears in the index — enriched with cross-session
 * identity fields.
 *
 * `payload` is typed as `unknown` because this layer doesn't need to know
 * each payload's exact shape. Consumers that care about a specific kind
 * narrow via a type guard or cast after checking `kind`.
 */
export type IndexedEvent = {
  sessionId: string;
  /** Sequence number within the originating session (0-based). */
  seq: number;
  /**
   * Unique, stable integer index across the whole bundle.
   * Assigned during indexing in chronological order:
   *   ordered[i].globalIdx === i
   *
   * Tie-break rule (events with identical `wall`):
   *   sort ascending by (sessionId, seq)
   * so that within a session the natural ordering is preserved and
   * across sessions the ordering is deterministic.
   */
  globalIdx: number;
  /** ISO 8601 UTC wall-clock timestamp. */
  wall: string;
  /** Milliseconds since session start (monotonic within session). */
  t: number;
  kind: EventKind;
  /** Raw event payload — narrow after checking `kind`. */
  payload: unknown;
  /**
   * File path this event is associated with, if any.
   * Extracted by getFileFromPayload() in build-index.ts.
   * Undefined for session-level and non-file events.
   */
  file?: string;
};

// ---------------------------------------------------------------------------
// EventIndex
// ---------------------------------------------------------------------------

export type EventIndex = {
  /** Key: `${sessionId}:${seq}` — O(1) lookup by session-local identity. */
  bySeq: Map<string, IndexedEvent>;
  /** All events of a given kind, in chronological order. */
  byKind: Map<EventKind, IndexedEvent[]>;
  /** All events for a given file path, in chronological order. */
  byFile: Map<string, IndexedEvent[]>;
  /** All events for a given session, in chronological order. */
  bySessionId: Map<string, IndexedEvent[]>;
  /** All events, sorted chronologically across sessions. */
  ordered: IndexedEvent[];
};
