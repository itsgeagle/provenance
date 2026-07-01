/**
 * clock_jumps heuristic (Phase 17).
 *
 * PRD §7.4 integrity: "Clock skew events detected — system clock may have
 * been manipulated to obscure the true timeline."
 *
 * Fires when either:
 *   (a) A single `clock.skew` event has `delta_ms > singleJumpThresholdMs`
 *       (default: 5 minutes = 300,000ms). One large clock jump is suspicious.
 *   (b) Multiple `clock.skew` events exist in a session (≥ multipleJumpsMin,
 *       default: 2). Repeated small skews collectively suggest instability.
 *
 * Severity: 'medium'. Confidence: 0.8.
 * (Clock skew events are always recorder-emitted, not analyst-inferred.)
 *
 * One flag per session that triggers either condition. Uses the first clock.skew
 * event's seq as the primary supporting event; all clock.skew seqs in the session
 * are included as additional supporting seqs.
 */

import type { EventIndex } from '../index/event-index.js';
import type { Bundle } from '../loader/types.js';
import type { Flag, Heuristic } from './types.js';
import type { HeuristicConfig } from './config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function flagId(sessionId: string, idx: number): string {
  return `clock_jumps-${sessionId}-${idx}`;
}

// ---------------------------------------------------------------------------
// Heuristic implementation
// ---------------------------------------------------------------------------

function run(index: EventIndex, _bundle: Bundle, config: HeuristicConfig): Flag[] {
  const { singleJumpThresholdMs, multipleJumpsMin } = config.clockJumps;
  const flags: Flag[] = [];
  let flagIndex = 0;

  for (const [sessionId, sessionEvents] of index.bySessionId) {
    const skewEvents = sessionEvents.filter((e) => e.kind === 'clock.skew');
    if (skewEvents.length === 0) continue;

    // Compute max delta across all skew events in this session.
    let maxDeltaMs = 0;
    let maxDeltaEvent = skewEvents[0]!;
    for (const ev of skewEvents) {
      const payload = ev.payload as Record<string, unknown> | null;
      const deltaMs = typeof payload?.['delta_ms'] === 'number' ? payload['delta_ms'] : 0;
      if (Math.abs(deltaMs) > Math.abs(maxDeltaMs)) {
        maxDeltaMs = deltaMs;
        maxDeltaEvent = ev;
      }
    }

    const singleJump = Math.abs(maxDeltaMs) > singleJumpThresholdMs;
    const multipleJumps = skewEvents.length >= multipleJumpsMin;

    if (!singleJump && !multipleJumps) continue;

    const reason = singleJump
      ? `Single clock jump of ${Math.round(Math.abs(maxDeltaMs) / 1000)}s exceeds the ${Math.round(singleJumpThresholdMs / 1000)}s threshold.`
      : `${skewEvents.length} clock skew events detected in this session (threshold: ${multipleJumpsMin}).`;

    const supportingSeqs = skewEvents.map((e) => `${e.sessionId}:${e.seq}`);

    flags.push({
      id: flagId(sessionId, flagIndex++),
      heuristic: 'clock_jumps',
      title: `Clock skew detected in session ${sessionId.slice(0, 8)}…`,
      severity: 'medium',
      confidence: 0.8,
      supportingSeqs,
      description:
        `${reason} The system clock may have been adjusted during the session, ` +
        `which could obscure the true timeline of editing activity.`,
      detail: {
        sessionId,
        skewEventCount: skewEvents.length,
        maxDeltaMs,
        maxDeltaAtSeq: maxDeltaEvent.seq,
        triggeredBy: singleJump ? 'single_large_jump' : 'multiple_jumps',
      },
    });
  }

  return flags;
}

export const clockJumpsHeuristic: Heuristic = {
  id: 'clock_jumps',
  label: 'Clock skew detected (possible clock manipulation)',
  run,
};
