/**
 * SessionSelect — which session the playhead is currently inside, plus random
 * access to any other session in the bundle.
 *
 * Replay spans the whole bundle (see the multi-session replay design), so a
 * session is no longer a scope you enter — it is a region the playhead moves
 * through. That makes this control two things at once:
 *
 *   1. A LIVE READOUT. `currentSessionId` comes from engine state, which updates
 *      on every tick, so the selection changes on its own as playback crosses a
 *      seam. It is not a setting the user owns.
 *   2. A SEEK. Choosing a session hands the parent that session's first
 *      globalIdx. It does NOT navigate — the URL's session identifier is only an
 *      entry anchor, and routing to it would not move the playhead.
 *
 * Adjacent-session movement is already covered by the seam ticks, the seam
 * dividers in the event sidebar, and the ⏭ Session jump button. What this adds
 * is jumping straight to session 7 of 12, and knowing where you are at a glance.
 */

import { useMemo } from 'react';
import type { EventIndex, IndexedEvent } from '@provenance/analysis-core/index/event-index.js';

type SessionSelectProps = {
  /** Whole-bundle index. Both the option list and the seek targets come from bySessionId. */
  index: EventIndex;
  /** The session the playhead is inside — engine-derived (ReplayState.sessionId), not URL-derived. */
  currentSessionId: string;
  /** Seek the whole-bundle playhead to this globalIdx. */
  onSeek(globalIdx: number): void;
};

/**
 * `Session 2 of 3 · 1/14/2026, 9:04:11 AM · 812 events`
 *
 * The timestamp is dropped when the session's first event carries an
 * unparseable `wall`. Cross-machine clock damage is a real condition in this
 * system — the clock_jumps heuristic exists for it — and "Invalid Date" in a
 * dropdown is worse than no date at all.
 */
function optionLabel(ordinal: number, total: number, events: readonly IndexedEvent[]): string {
  const parts = [`Session ${ordinal} of ${total}`];

  const startWall = events[0]?.wall ?? null;
  if (startWall !== null && !Number.isNaN(Date.parse(startWall))) {
    parts.push(new Date(startWall).toLocaleString());
  }

  parts.push(`${events.length} ${events.length === 1 ? 'event' : 'events'}`);
  return parts.join(' · ');
}

export function SessionSelect({ index, currentSessionId, onSeek }: SessionSelectProps) {
  // bySessionId is built from wall-sorted events, so key order is oldest → newest.
  const sessionIds = useMemo(() => [...index.bySessionId.keys()], [index]);

  // Nothing to choose between: single-session bundles render exactly as before
  // this control existed, and zero-event bundles fall through the same branch.
  if (sessionIds.length <= 1) return null;

  const total = sessionIds.length;
  const ordinal = sessionIds.indexOf(currentSessionId) + 1;

  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const first = index.bySessionId.get(e.target.value)?.[0];
    if (first !== undefined) onSeek(first.globalIdx);
  }

  return (
    // The trailing divider lives here rather than in the parent row so it
    // disappears along with the control on single-session bundles.
    <div
      className="flex shrink-0 items-center gap-2 border-r pr-3"
      data-testid="replay-session-switcher"
    >
      <select
        aria-label="Session"
        value={currentSessionId}
        onChange={handleChange}
        className="max-w-[22rem] rounded-md border bg-background px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        data-testid="replay-session-select"
      >
        {sessionIds.map((id, i) => (
          <option key={id} value={id}>
            {optionLabel(i + 1, total, index.bySessionId.get(id) ?? [])}
          </option>
        ))}
      </select>
      {ordinal > 0 && (
        <span
          className="shrink-0 text-xs font-medium text-muted-foreground tabular-nums"
          data-testid="replay-session-ordinal"
          aria-hidden="true"
        >
          {ordinal} / {total}
        </span>
      )}
    </div>
  );
}
