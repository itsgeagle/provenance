/**
 * file-recency — "when was this file last edited, relative to the playhead?"
 *
 * Drives the replay tab strip. Because replay spans the whole bundle, the tab
 * strip lists every file in the submission — including ones the student hasn't
 * touched in the session the playhead is currently sitting in. Without a recency
 * signal those stale tabs are indistinguishable from actively-edited ones.
 *
 * Pure: no React, no DOM.
 */

import type { EventIndex, IndexedEvent } from '@provenance/analysis-core/index/event-index.js';

export type FileRecency =
  /** No event for this file at or before the playhead. */
  | { state: 'untouched' }
  /** Last edited within the session the playhead is in. */
  | { state: 'current-session'; agoMs: number }
  /** Last edited in an earlier session. */
  | { state: 'earlier-session'; sessionsAgo: number };

/**
 * The last event for `filePath` at or before `currentGlobalIdx`.
 *
 * `index.byFile` is already sorted ascending by globalIdx, so this is a binary
 * search rather than a scan — the tab strip re-computes on every playhead move.
 */
function lastEventAtOrBefore(
  events: readonly IndexedEvent[],
  currentGlobalIdx: number,
): IndexedEvent | null {
  let lo = 0;
  let hi = events.length - 1;
  let found: IndexedEvent | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const e = events[mid]!;
    if (e.globalIdx <= currentGlobalIdx) {
      found = e;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

function parseWallMs(wall: string): number {
  const ms = Date.parse(wall);
  return Number.isFinite(ms) ? ms : NaN;
}

export function computeFileRecency(
  index: EventIndex,
  filePath: string,
  currentGlobalIdx: number,
  currentSessionId: string,
): FileRecency {
  const fileEvents = index.byFile.get(filePath);
  if (fileEvents === undefined || fileEvents.length === 0) return { state: 'untouched' };

  const last = lastEventAtOrBefore(fileEvents, currentGlobalIdx);
  if (last === null) return { state: 'untouched' };

  if (last.sessionId === currentSessionId) {
    const playhead = index.ordered[currentGlobalIdx];
    const nowMs = playhead !== undefined ? parseWallMs(playhead.wall) : NaN;
    const thenMs = parseWallMs(last.wall);
    // Floored at 0: clock skew must not produce a negative "ago".
    const agoMs =
      Number.isFinite(nowMs) && Number.isFinite(thenMs) ? Math.max(0, nowMs - thenMs) : 0;
    return { state: 'current-session', agoMs };
  }

  // Session distance, measured in bySessionId key order — which build-index
  // populates in `ordered` order, i.e. session-start chronological order.
  const sessionIds = Array.from(index.bySessionId.keys());
  const lastPos = sessionIds.indexOf(last.sessionId);
  const currentPos = sessionIds.indexOf(currentSessionId);
  const sessionsAgo = lastPos >= 0 && currentPos >= 0 ? Math.max(1, currentPos - lastPos) : 1;

  return { state: 'earlier-session', sessionsAgo };
}

/** Short badge text for a tab, or null when there is nothing to show. */
export function formatRecency(r: FileRecency): string | null {
  if (r.state === 'untouched') return null;

  if (r.state === 'earlier-session') {
    return r.sessionsAgo === 1 ? '1 session ago' : `${r.sessionsAgo} sessions ago`;
  }

  const seconds = Math.floor(r.agoMs / 1000);
  if (seconds <= 0) return 'now';
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}
