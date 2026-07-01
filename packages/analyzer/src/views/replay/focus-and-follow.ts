/**
 * focus-and-follow.ts — pure helpers for two replay behaviors:
 *
 *   1. The "focused away" overlay: detect whether the student was focused away
 *      from the VS Code window at the current playhead position.
 *   2. Auto-follow: determine which file is being edited at the current playhead
 *      so the editor can switch to it.
 *
 * Both functions are pure (no side effects, no React) and operate on a session's
 * chronologically-ordered events plus the playhead `currentGlobalIdx`.
 *
 * Recorder PRD §4.4 (focus.change), §4.2 (doc events).
 */

import type { IndexedEvent } from '@provenance/analysis-core/index/event-index.js';
import type { FocusChangePayload } from '@provenance/log-core';

/** File-bearing event kinds that indicate where the student is working. */
const FILE_EVENT_KINDS = new Set(['doc.change', 'paste', 'doc.save', 'doc.open']);

/** Active "focused away" state at the playhead, or null when focused (or before any event). */
export type FocusAwayState = { reason: string | null } | null;

/**
 * Whether the student is currently focused away from the window at the playhead.
 *
 * The student is "away" iff the most recent `focus.change` event at-or-before the
 * playhead has `gained: false` (and no later `gained: true` has occurred yet). When
 * away, returns the event's `reason` (or null when none was recorded).
 *
 * `events` must be chronologically ordered (ascending `globalIdx`), as the per-
 * session event lists from the EventIndex are.
 */
export function currentFocusAwaySpan(
  events: readonly IndexedEvent[],
  currentGlobalIdx: number,
): FocusAwayState {
  let away: FocusAwayState = null;
  for (const e of events) {
    if (e.globalIdx > currentGlobalIdx) break;
    if (e.kind !== 'focus.change') continue;
    const p = e.payload as FocusChangePayload;
    away = p.gained ? null : { reason: p.reason ?? null };
  }
  return away;
}

/**
 * The file being edited at the playhead = the path of the most recent file-bearing
 * event (`doc.change` / `paste` / `doc.save` / `doc.open`) at-or-before the playhead.
 * Returns null when no such event has occurred yet.
 *
 * `events` must be chronologically ordered (ascending `globalIdx`).
 */
export function currentEditedFile(
  events: readonly IndexedEvent[],
  currentGlobalIdx: number,
): string | null {
  let file: string | null = null;
  for (const e of events) {
    if (e.globalIdx > currentGlobalIdx) break;
    if (e.file != null && FILE_EVENT_KINDS.has(e.kind)) {
      file = e.file;
    }
  }
  return file;
}
