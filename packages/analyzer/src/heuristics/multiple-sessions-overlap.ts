/**
 * multiple_sessions_overlap heuristic (Phase 17).
 *
 * PRD §7.4 integrity: "Two sessions have overlapping wall-time ranges —
 * impossible on a single machine without clock manipulation or log forging."
 *
 * For each pair of sessions in the bundle, compare:
 *   - rangeA: [session.start.wall, session.end.wall]
 *   - rangeB: [session.start.wall, session.end.wall]
 *
 * If the two ranges overlap (i.e., A.start < B.end AND B.start < A.end),
 * emit a flag for that pair.
 *
 * Sessions with no `session.end` event are treated as open-ended — their
 * range is [session.start.wall, +Infinity). This means an open session always
 * overlaps any other session that starts after it, which is the conservative
 * (higher-sensitivity) choice.
 *
 * Note on bundle.sessions ordering: sessions are sorted oldest-first by
 * firstEvent.wall (done in the loader). We iterate all pairs N*(N-1)/2.
 * With typical bundle sizes (1–10 sessions) this is negligible.
 *
 * Severity: 'high'. Confidence: 0.95.
 * (Overlapping sessions are physically impossible on a single machine under
 * normal conditions. The main false positive is clock misconfiguration, but
 * that would also trigger monotonic_wall_regression.)
 *
 * One flag per overlapping pair. The supporting seqs are the session.start
 * events of each session.
 */

import type { EventIndex } from '../index/event-index.js';
import type { Bundle } from '../loader/types.js';
import type { Flag, Heuristic } from './types.js';
import type { HeuristicConfig } from './config.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SessionRange = {
  sessionId: string;
  startWall: number; // Date.parse result
  endWall: number; // Date.parse result, or Infinity if no session.end
  startSeq: number; // seq of session.start event
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function flagId(sessionIdA: string, sessionIdB: string): string {
  // Lexicographic sort to ensure A < B → stable, pair-order-independent ID.
  const [first, second] =
    sessionIdA < sessionIdB ? [sessionIdA, sessionIdB] : [sessionIdB, sessionIdA];
  return `multiple_sessions_overlap-${first}-${second}`;
}

function rangesOverlap(a: SessionRange, b: SessionRange): boolean {
  // Standard interval overlap: a.start < b.end AND b.start < a.end.
  // Open-ended sessions have endWall = Infinity, so they always "end after" anything.
  return a.startWall < b.endWall && b.startWall < a.endWall;
}

// ---------------------------------------------------------------------------
// Heuristic implementation
// ---------------------------------------------------------------------------

function run(index: EventIndex, _bundle: Bundle, _config: HeuristicConfig): Flag[] {
  // Build a session range per session using index.bySessionId.
  const ranges: SessionRange[] = [];

  for (const [sessionId, sessionEvents] of index.bySessionId) {
    const startEvent = sessionEvents.find((e) => e.kind === 'session.start');
    const endEvent = sessionEvents.find((e) => e.kind === 'session.end');

    if (startEvent === undefined) continue;

    const startWall = Date.parse(startEvent.wall);
    if (Number.isNaN(startWall)) continue;

    const endWall = endEvent !== undefined ? Date.parse(endEvent.wall) : Infinity;

    ranges.push({
      sessionId,
      startWall,
      endWall: Number.isNaN(endWall) ? Infinity : endWall,
      startSeq: startEvent.seq,
    });
  }

  if (ranges.length < 2) return [];

  const flags: Flag[] = [];
  const emittedPairs = new Set<string>();

  for (let i = 0; i < ranges.length; i++) {
    for (let j = i + 1; j < ranges.length; j++) {
      const a = ranges[i]!;
      const b = ranges[j]!;

      if (!rangesOverlap(a, b)) continue;

      const pairId = flagId(a.sessionId, b.sessionId);
      if (emittedPairs.has(pairId)) continue;
      emittedPairs.add(pairId);

      // Supporting seqs: the session.start events of both sessions.
      const supportingSeqs = [`${a.sessionId}:${a.startSeq}`, `${b.sessionId}:${b.startSeq}`];

      const aEndLabel = a.endWall === Infinity ? 'open' : new Date(a.endWall).toISOString();
      const bEndLabel = b.endWall === Infinity ? 'open' : new Date(b.endWall).toISOString();

      flags.push({
        id: pairId,
        heuristic: 'multiple_sessions_overlap',
        title: `Sessions overlap: ${a.sessionId.slice(0, 8)}… and ${b.sessionId.slice(0, 8)}…`,
        severity: 'high',
        confidence: 0.95,
        supportingSeqs,
        description:
          `Sessions "${a.sessionId}" and "${b.sessionId}" have overlapping wall-time ranges. ` +
          `Session A: [${new Date(a.startWall).toISOString()}, ${aEndLabel}]. ` +
          `Session B: [${new Date(b.startWall).toISOString()}, ${bEndLabel}]. ` +
          `Overlapping sessions are impossible on a single machine without clock manipulation ` +
          `or log forging.`,
        detail: {
          sessionA: a.sessionId,
          sessionB: b.sessionId,
          sessionAStartWall: new Date(a.startWall).toISOString(),
          sessionAEndWall: aEndLabel,
          sessionBStartWall: new Date(b.startWall).toISOString(),
          sessionBEndWall: bEndLabel,
        },
      });
    }
  }

  return flags;
}

export const multipleSessionsOverlapHeuristic: Heuristic = {
  id: 'multiple_sessions_overlap',
  label: 'Multiple sessions with overlapping wall-time ranges',
  run,
};
