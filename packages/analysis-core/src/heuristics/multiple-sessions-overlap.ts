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
 * Sessions with no `session.end` event are bounded at their LAST RECORDED
 * EVENT's wall, not at +Infinity.
 *
 * A missing `session.end` is the ordinary crash signature, not a suspicious
 * one: the recorder only emits `session.end` from `deactivate()`, which the
 * editor skips whenever the window is killed, the OS shuts down, or the host
 * process dies. The recorder itself already reads this as a crash — see
 * `previous_session_dangling` in the recorder's `startup/chain-recovery.ts`.
 *
 * Treating such a session as running until +Infinity claimed it overlapped
 * every session that started after it, forever — one crash on day 1 flagged
 * every session for the rest of the assignment. The last recorded event is the
 * last moment the session demonstrably existed; extending the range past it
 * invents evidence. A session whose only event is `session.start` therefore
 * has a zero-length range and cannot overlap anything, which is correct: it
 * never demonstrably ran concurrently with anything.
 *
 * This preserves the real signal — two sessions genuinely recording events in
 * the same wall-clock window still overlap and still flag.
 *
 * Do NOT reintroduce a "same machine_id → suppress" guard. `machine_id` is
 * sha256(hostname:username:sessionId) in all three recorders (VS Code,
 * JetBrains, Neovim) — session-salted by design, per PRD §5.1, to prevent
 * cross-assignment correlation. It is therefore unique per session and can
 * never match across two sessions, so such a guard is unreachable. An earlier
 * version of this file carried one; it was dead code, and its unit tests passed
 * only because the fixtures hand-set a shared machine_id no recorder can emit.
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
  /**
   * Date.parse of `session.end`'s wall, or — when the session has no
   * `session.end` (crash) — of its last recorded event's wall. Never
   * +Infinity: see the module comment.
   */
  endWall: number;
  startSeq: number; // seq of session.start event
  /** True when the session has no `session.end` event (crashed / killed). */
  openEnded: boolean;
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
  // Strict `<` means zero-length ranges (a session whose only event is
  // session.start) never overlap anything.
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

    // A crashed session (no session.end) is bounded at its last recorded event
    // — the last moment it demonstrably existed. bySessionId is chronological.
    const openEnded = endEvent === undefined;
    const boundingEvent = endEvent ?? sessionEvents[sessionEvents.length - 1];
    const parsedEnd = boundingEvent !== undefined ? Date.parse(boundingEvent.wall) : NaN;

    // An unparseable or backwards end (clock skew — monotonic_wall_regression
    // covers that separately) collapses the range to zero length rather than
    // extending it.
    const endWall = Number.isNaN(parsedEnd) ? startWall : Math.max(parsedEnd, startWall);

    ranges.push({
      sessionId,
      startWall,
      endWall,
      startSeq: startEvent.seq,
      openEnded,
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

      // Label a crash-bounded end so a reader knows the bound came from the last
      // recorded event rather than a real session.end.
      const endLabel = (r: SessionRange): string =>
        r.openEnded
          ? `${new Date(r.endWall).toISOString()} (last event; no session.end)`
          : new Date(r.endWall).toISOString();

      const aEndLabel = endLabel(a);
      const bEndLabel = endLabel(b);

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
          sessionAOpenEnded: a.openEnded,
          sessionBOpenEnded: b.openEnded,
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
