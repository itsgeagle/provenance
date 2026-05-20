/**
 * gap_in_heartbeats heuristic (Phase 17).
 *
 * PRD §7.4 integrity: "Consecutive heartbeats more than 5 minutes apart with
 * no session end/start pair between them — suggests the recorder may have been
 * paused or the log file altered."
 *
 * Logic:
 *   For each session, iterate consecutive pairs of `session.heartbeat` events
 *   (ordered by seq). Compute the wall-time gap between each pair. If the gap
 *   exceeds `gapThresholdMs` (default: 5 minutes) AND there is no `session.end`
 *   followed by `session.start` in that gap window (which would explain the
 *   pause), emit a flag.
 *
 * "No session.end/session.start pair between them" is determined by checking
 * whether any `session.end` event exists in the same session with `seq` between
 * the two heartbeats. Because heartbeat events are single-session, cross-session
 * boundaries cannot occur between two heartbeats of the same session.
 *
 * Wall-time comparison: heartbeat `wall` field (ISO 8601 string). We use
 * Date.parse() for the diff — this is safe because we are not injecting into
 * any log (this is read-only analysis). Non-parseable wall strings produce NaN,
 * which comparison guards handle by skipping.
 *
 * Severity: 'medium'. Confidence: 0.75.
 * (Gaps can be legitimate — the student closed their laptop. But without a
 * session.end, the recorder should have kept heartbeating.)
 *
 * One flag per gap (not per session). Multiple gaps in one session → multiple
 * flags, each pointing to the two bounding heartbeat events.
 */

import type { EventIndex } from '../index/event-index.js';
import type { Bundle } from '../loader/types.js';
import type { Flag, Heuristic } from './types.js';
import type { HeuristicConfig } from './config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function flagId(sessionId: string, heartbeatASeq: number, heartbeatBSeq: number): string {
  return `gap_in_heartbeats-${sessionId}-${heartbeatASeq}-${heartbeatBSeq}`;
}

function wallToMs(wall: string): number {
  return Date.parse(wall);
}

// ---------------------------------------------------------------------------
// Heuristic implementation
// ---------------------------------------------------------------------------

function run(index: EventIndex, _bundle: Bundle, config: HeuristicConfig): Flag[] {
  const { gapThresholdMs } = config.gapInHeartbeats;
  const flags: Flag[] = [];

  for (const [sessionId, sessionEvents] of index.bySessionId) {
    // Collect heartbeat events in seq order (already sorted in sessionEvents).
    const heartbeats = sessionEvents.filter((e) => e.kind === 'session.heartbeat');
    if (heartbeats.length < 2) continue;

    // Build a Set of seqs at which session.end events occur in this session.
    // This lets us quickly check if a session ended between two heartbeats.
    const sessionEndSeqs = new Set<number>(
      sessionEvents.filter((e) => e.kind === 'session.end').map((e) => e.seq),
    );

    for (let i = 0; i < heartbeats.length - 1; i++) {
      const hA = heartbeats[i]!;
      const hB = heartbeats[i + 1]!;

      const wallA = wallToMs(hA.wall);
      const wallB = wallToMs(hB.wall);

      if (Number.isNaN(wallA) || Number.isNaN(wallB)) continue;

      const gapMs = wallB - wallA;
      if (gapMs <= gapThresholdMs) continue;

      // Check if a session.end exists between these two heartbeats (by seq).
      // If so, the gap is expected — the session ended and hasn't restarted yet.
      const hasSessionEndInGap = [...sessionEndSeqs].some((seq) => seq > hA.seq && seq < hB.seq);
      if (hasSessionEndInGap) continue;

      flags.push({
        id: flagId(sessionId, hA.seq, hB.seq),
        heuristic: 'gap_in_heartbeats',
        title: `Heartbeat gap of ${Math.round(gapMs / 60_000)}min in session ${sessionId.slice(0, 8)}…`,
        severity: 'medium',
        confidence: 0.75,
        supportingSeqs: [`${hA.sessionId}:${hA.seq}`, `${hB.sessionId}:${hB.seq}`],
        description:
          `A gap of ${Math.round(gapMs / 60_000)} minutes was found between consecutive ` +
          `heartbeat events (seqs ${hA.seq}→${hB.seq}) with no session.end between them. ` +
          `This may indicate the recorder was paused, the log file was modified, or the ` +
          `student worked offline without the recorder running.`,
        detail: {
          sessionId,
          heartbeatASeq: hA.seq,
          heartbeatBSeq: hB.seq,
          heartbeatAWall: hA.wall,
          heartbeatBWall: hB.wall,
          gapMs,
        },
      });
    }
  }

  return flags;
}

export const gapInHeartbeatsHeuristic: Heuristic = {
  id: 'gap_in_heartbeats',
  label: 'Unexplained heartbeat gap (>5 min without session end)',
  run,
};
