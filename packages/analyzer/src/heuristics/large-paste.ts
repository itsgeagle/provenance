/**
 * large_paste heuristic (Phase 4).
 *
 * PRD §7.4: "Single paste with text length ≥ 200 chars or ≥ 10 lines."
 *
 * Emits one Flag per qualifying paste event. Severity escalates to high when
 * the paste exceeds the high-severity thresholds (500 chars or 30 lines by
 * default — see config.ts for the rubric).
 *
 * Confidence is 0.8 for normal paste events. If a paste event is temporally
 * adjacent to a paste.anomaly event (within the same session's event stream),
 * confidence is reduced to 0.6 because the paste detection is less reliable
 * in that context (paste.anomaly fires when the recorder's paste detection
 * heuristics had low confidence themselves).
 *
 * paste.anomaly adjacency rule:
 *   A paste event P is "in an anomaly window" if the previous or next event
 *   of kind paste.anomaly in the SAME session has |t_P - t_anomaly| ≤ 5000ms.
 */

import type { EventIndex, IndexedEvent } from '../index/event-index.js';
import type { Bundle } from '../loader/types.js';
import type { Flag, Heuristic, Severity } from './types.js';
import type { HeuristicConfig } from './config.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build a set of session-local `t` windows occupied by paste.anomaly events
 * (keyed by sessionId).
 *
 * We index these up front so the paste-event loop is O(1) per paste.
 */
function buildAnomalyWindows(index: EventIndex): Map<string, number[]> {
  const bySession = new Map<string, number[]>();
  // paste.anomaly is not a standard EventKind yet in log-core; use the cast
  // pattern from stats.ts to future-proof.
  const anomalyEvents = (index.byKind as Map<string, IndexedEvent[]>).get('paste.anomaly') ?? [];
  for (const e of anomalyEvents) {
    let arr = bySession.get(e.sessionId);
    if (arr === undefined) {
      arr = [];
      bySession.set(e.sessionId, arr);
    }
    arr.push(e.t);
  }
  return bySession;
}

const ANOMALY_WINDOW_MS = 5000;
const ANOMALY_CONFIDENCE = 0.6;
const NORMAL_CONFIDENCE = 0.8;

function isInAnomalyWindow(t: number, anomalyTs: number[] | undefined): boolean {
  if (anomalyTs === undefined || anomalyTs.length === 0) return false;
  return anomalyTs.some((at) => Math.abs(t - at) <= ANOMALY_WINDOW_MS);
}

// ---------------------------------------------------------------------------
// Flag ID construction (deterministic, no Math.random / Date.now)
// ---------------------------------------------------------------------------

function flagId(seq0: string, index: number): string {
  return `large_paste-${seq0}-${index}`;
}

// ---------------------------------------------------------------------------
// Heuristic implementation
// ---------------------------------------------------------------------------

function run(index: EventIndex, _bundle: Bundle, config: HeuristicConfig): Flag[] {
  const { minChars, minLines, highSeverityChars, highSeverityLines } = config.largePaste;

  const pasteEvents = index.byKind.get('paste') ?? [];
  const anomalyWindows = buildAnomalyWindows(index);

  const flags: Flag[] = [];
  let flagIndex = 0;

  for (const e of pasteEvents) {
    const p = e.payload as Record<string, unknown> | null;
    if (typeof p !== 'object' || p === null) continue;

    // `length` is always present on paste payloads (even large pastes that
    // omit `content`). This is the authoritative character count.
    const length = typeof p['length'] === 'number' ? p['length'] : 0;

    // Line count: count newlines in `content` if available; otherwise fall back
    // to estimating from length (we can only reliably flag by lines when we have
    // the content).
    let lines = 0;
    if (typeof p['content'] === 'string') {
      // Count newline-separated lines (a string with N '\n' chars has N+1 lines).
      lines = (p['content'] as string).split('\n').length;
    }

    // Check threshold. We flag on either chars OR lines.
    const meetsCharThreshold = length >= minChars;
    const meetsLineThreshold = lines >= minLines;
    if (!meetsCharThreshold && !meetsLineThreshold) continue;

    // Severity: escalate if either high-severity threshold is met.
    const severity: Severity =
      length >= highSeverityChars || lines >= highSeverityLines ? 'high' : 'medium';

    // Confidence: reduced if inside a paste.anomaly window.
    const anomalyTs = anomalyWindows.get(e.sessionId);
    const confidence = isInAnomalyWindow(e.t, anomalyTs) ? ANOMALY_CONFIDENCE : NORMAL_CONFIDENCE;

    const supportingSeqKey = `${e.sessionId}:${e.seq}`;
    const id = flagId(supportingSeqKey, flagIndex++);

    const path = typeof p['path'] === 'string' ? p['path'] : 'unknown file';
    const lineInfo = lines > 0 ? `, ${lines} lines` : '';

    flags.push({
      id,
      heuristic: 'large_paste',
      title: `Large paste in ${path}`,
      severity,
      confidence,
      supportingSeqs: [supportingSeqKey],
      description: `A paste of ${length} characters${lineInfo} was detected in ${path}.`,
      detail: {
        path,
        charCount: length,
        lineCount: lines > 0 ? lines : null,
        inAnomalyWindow: isInAnomalyWindow(e.t, anomalyTs),
      },
    });
  }

  return flags;
}

export const largePasteHeuristic: Heuristic = {
  id: 'large_paste',
  label: 'Large paste',
  run,
};
