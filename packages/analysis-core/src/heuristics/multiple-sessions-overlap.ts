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
 * emit a flag for that pair — UNLESS both sessions came from the same host
 * (session.start.data.machine_id) AND the same recorder
 * (session.start.data.recorder.extension_id). Multiple concurrent editor
 * instances on one machine (notably the Neovim recorder run in several
 * terminals/tmux panes on the same workspace) produce genuinely overlapping
 * sessions that are honest, not forgery, so that specific case is suppressed.
 * Overlaps across different hosts or different recorders remain flagged.
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

import type { SessionStartPayload } from '@provenance/log-core';
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
  /**
   * Machine identity from session.start.data.machine_id — the "same host"
   * signal. `null` when the payload didn't carry a usable value.
   */
  machineId: string | null;
  /**
   * Recorder identity from session.start.data.recorder.extension_id — the
   * "same recorder" signal. `null` when the payload didn't carry a usable value.
   */
  extensionId: string | null;
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

/**
 * True when both sessions demonstrably came from the same machine AND the same
 * recorder. Such an overlap is a legitimate concurrent-editor situation (e.g.
 * two Neovim instances on one workspace in two terminals/tmux panes) rather than
 * clock manipulation or a two-machine forgery, so the overlap flag is suppressed.
 *
 * Identity is taken from the session.start payload:
 *   - host     = data.machine_id
 *   - recorder = data.recorder.extension_id
 *
 * Missing/blank identity on either side is treated as "not confirmed same" and
 * therefore does NOT suppress the flag — the conservative, anti-cheat-preserving
 * default. Overlaps across different hosts or different recorders (a real
 * "two machines stitched together" signal) always remain flagged.
 */
function sameHostSameRecorder(a: SessionRange, b: SessionRange): boolean {
  return (
    a.machineId !== null &&
    b.machineId !== null &&
    a.machineId === b.machineId &&
    a.extensionId !== null &&
    b.extensionId !== null &&
    a.extensionId === b.extensionId
  );
}

/** Extract a non-empty string identity from an arbitrary payload field. */
function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
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

    // Host/recorder identity live on the session.start payload. Narrow from the
    // index's `unknown` payload; treat anything missing/blank as unknown (null).
    const payload = startEvent.payload as Partial<SessionStartPayload> | undefined;
    const machineId = nonEmpty(payload?.machine_id);
    const extensionId = nonEmpty(payload?.recorder?.extension_id);

    ranges.push({
      sessionId,
      startWall,
      endWall: Number.isNaN(endWall) ? Infinity : endWall,
      startSeq: startEvent.seq,
      machineId,
      extensionId,
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

      // Legitimate concurrent editing on one machine with one recorder (e.g.
      // two Neovim instances on the same workspace) genuinely overlaps in
      // wall-time and is not forgery. Suppress the flag only when both the host
      // and the recorder identity match; cross-host / cross-recorder overlaps
      // stay flagged as a real "two machines stitched together" signal.
      if (sameHostSameRecorder(a, b)) continue;

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
