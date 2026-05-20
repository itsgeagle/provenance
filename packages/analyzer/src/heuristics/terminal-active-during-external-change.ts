/**
 * terminal_active_during_external_change heuristic (Phase 17).
 *
 * PRD §7.4 environment: "A terminal was open at the time an external file
 * change occurred, suggesting the external change may have been script-driven."
 *
 * Logic:
 *   For each `fs.external_change` event, check whether any terminal was open
 *   at that time within the same session. A terminal is considered "open" if
 *   the session has any `terminal.open` event with `t ≤ externalChange.t` and
 *   no corresponding close (terminal.close is not in the event set — the
 *   recorder does not emit terminal.close events in v1). We therefore treat
 *   a terminal as open from its `terminal.open` event until the session ends.
 *
 * This is a weak signal: an open terminal is common and doesn't prove the
 * external change was script-driven. However, combined with `mass_external_
 * replacement` or `external_edits` flags, it strengthens the case.
 *
 * Severity: 'info'. Confidence: 0.6.
 *
 * One flag per `fs.external_change` event that co-occurs with an open terminal.
 * De-duplicated by the change event's seq.
 */

import type { EventIndex } from '../index/event-index.js';
import type { Bundle } from '../loader/types.js';
import type { Flag, Heuristic } from './types.js';
import type { HeuristicConfig } from './config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function flagId(sessionId: string, seq: number): string {
  return `terminal_active_during_external_change-${sessionId}-${seq}`;
}

// ---------------------------------------------------------------------------
// Heuristic implementation
// ---------------------------------------------------------------------------

function run(index: EventIndex, _bundle: Bundle, _config: HeuristicConfig): Flag[] {
  const flags: Flag[] = [];

  for (const [, sessionEvents] of index.bySessionId) {
    // Collect terminal open times (t values) for this session.
    // Since terminal.close is not emitted, any terminal opened before t remains open.
    const terminalOpenTimes: number[] = sessionEvents
      .filter((e) => e.kind === 'terminal.open')
      .map((e) => e.t);

    if (terminalOpenTimes.length === 0) continue;

    // For each external change, check if any terminal was already open (open.t <= change.t).
    const externalChangeEvents = sessionEvents.filter((e) => e.kind === 'fs.external_change');
    for (const ev of externalChangeEvents) {
      const terminalWasOpen = terminalOpenTimes.some((openT) => openT <= ev.t);
      if (!terminalWasOpen) continue;

      const payload = ev.payload as Record<string, unknown> | null;
      const filePath = typeof payload?.['path'] === 'string' ? payload['path'] : 'unknown';
      const diffSize = typeof payload?.['diff_size'] === 'number' ? payload['diff_size'] : null;

      flags.push({
        id: flagId(ev.sessionId, ev.seq),
        heuristic: 'terminal_active_during_external_change',
        title: `Terminal open during external file change: ${filePath}`,
        severity: 'info',
        confidence: 0.6,
        supportingSeqs: [`${ev.sessionId}:${ev.seq}`],
        description:
          `A terminal was open when the file "${filePath}" was externally changed ` +
          `(diff_size: ${diffSize ?? 'unknown'} chars). This may indicate a script or ` +
          `automated tool was responsible for the file change.`,
        detail: {
          sessionId: ev.sessionId,
          filePath,
          diffSize,
          terminalOpenCount: terminalOpenTimes.length,
          externalChangeT: ev.t,
          externalChangeSeq: ev.seq,
        },
      });
    }
  }

  return flags;
}

export const terminalActiveDuringExternalChangeHeuristic: Heuristic = {
  id: 'terminal_active_during_external_change',
  label: 'Terminal active during external file change',
  run,
};
