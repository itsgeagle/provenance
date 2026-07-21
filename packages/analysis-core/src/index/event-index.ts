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
  /**
   * Workspace-root path aliases that were canonicalized away (D3): alias path →
   * canonical manifest path. Empty in the normal case. Exposed so the UI can
   * explain why events recorded under `sub/hw.py` appear under `hw.py`.
   * See `resolveWorkspaceRootAliases`. Optional: hand-built indexes in tests
   * and `buildIndexFromEventRows` omit it.
   */
  pathAliases?: Map<string, string>;
  /**
   * globalIdx of every `fs.external_change` reclassified as the recorder
   * reacting to the editor's own save rather than a third-party write — from
   * either the save path (D1) or the fs-watcher path (D1b).
   *
   * Computed once here so reconstruction and every heuristic agree on which
   * events are real. Consumers that report on external changes MUST skip these
   * — they describe something that never happened. They are kept in `byKind`
   * and `ordered` rather than deleted so the timeline can still show them as
   * reclassified. See `isSelfInflictedSave` and
   * `.notes/external-change-false-positives.md`.
   */
  selfInflictedExternalChanges?: Set<number>;
};
