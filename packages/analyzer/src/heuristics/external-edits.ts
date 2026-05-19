/**
 * external_edits heuristic (Phase 4).
 *
 * PRD §7.4: "Any fs.external_change event not preceded by a known formatter."
 *
 * Emits one Flag per group of coalesced fs.external_change events. Grouping
 * rule: consecutive events on the SAME FILE within a 2-second window (measured
 * by the `t` field — ms since session start) are merged into a single flag.
 * This prevents one CLI operation that touches multiple successive saves from
 * flooding the dashboard.
 *
 * A fs.external_change event is "explained" if its payload contains:
 *   explanation: 'formatter' | 'git'
 * Explained events are silently skipped and do NOT produce flags.
 *
 * Severity:
 *   - medium: any unexplained fs.external_change
 *   - high:   unexplained AND |diff_size| > highSeverityCharsChanged (default 100)
 *
 * Confidence: 0.9 for unexplained external changes (hard signal — the recorder
 * only emits fs.external_change when a file changes without a VS Code editor
 * being responsible).
 */

import type { EventIndex, IndexedEvent } from '../index/event-index.js';
import type { Bundle } from '../loader/types.js';
import type { Flag, Heuristic, Severity } from './types.js';
import type { HeuristicConfig } from './config.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONFIDENCE = 0.9;

const EXPLAINED_VALUES = new Set<string>(['formatter', 'git']);

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isExplained(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) return false;
  const p = payload as Record<string, unknown>;
  const explanation = p['explanation'];
  return typeof explanation === 'string' && EXPLAINED_VALUES.has(explanation);
}

function getDiffSize(payload: unknown): number {
  if (typeof payload !== 'object' || payload === null) return 0;
  const p = payload as Record<string, unknown>;
  const diffSize = p['diff_size'];
  return typeof diffSize === 'number' ? Math.abs(diffSize) : 0;
}

function getFilePath(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) return 'unknown';
  const p = payload as Record<string, unknown>;
  return typeof p['path'] === 'string' ? p['path'] : 'unknown';
}

function flagId(seqKey: string, index: number): string {
  return `external_edits-${seqKey}-${index}`;
}

// ---------------------------------------------------------------------------
// Coalesce groups
// ---------------------------------------------------------------------------

/**
 * A group of fs.external_change events that have been coalesced into a single
 * flag. All events are on the same file and within the coalesce window.
 */
type CoalescedGroup = {
  file: string;
  events: IndexedEvent[];
  /** Maximum |diff_size| seen in the group. */
  maxDiffSize: number;
};

/**
 * Given a list of unexplained fs.external_change events (all for a given file,
 * already in chronological order by `t`), group them into coalesced windows.
 *
 * The 2-second window is measured between consecutive events' `t` values
 * (ms since session start). Two events on different sessions cannot be
 * coalesced even if their wall times overlap — the `t` field is session-local.
 * Therefore we coalesce only within sessions.
 */
function coalesceGroups(events: IndexedEvent[], windowMs: number): CoalescedGroup[] {
  if (events.length === 0) return [];

  const groups: CoalescedGroup[] = [];
  let currentGroup: CoalescedGroup | null = null;

  for (const e of events) {
    const diffSize = getDiffSize(e.payload);
    const file = getFilePath(e.payload);

    if (currentGroup === null) {
      currentGroup = { file, events: [e], maxDiffSize: diffSize };
      continue;
    }

    // Only coalesce within the same session (t is session-local).
    const prev = currentGroup.events[currentGroup.events.length - 1]!;
    const sameSession = prev.sessionId === e.sessionId;
    const withinWindow = sameSession && e.t - prev.t <= windowMs;

    if (withinWindow) {
      currentGroup.events.push(e);
      if (diffSize > currentGroup.maxDiffSize) {
        currentGroup.maxDiffSize = diffSize;
      }
    } else {
      groups.push(currentGroup);
      currentGroup = { file, events: [e], maxDiffSize: diffSize };
    }
  }

  if (currentGroup !== null) {
    groups.push(currentGroup);
  }

  return groups;
}

// ---------------------------------------------------------------------------
// Heuristic implementation
// ---------------------------------------------------------------------------

function run(index: EventIndex, _bundle: Bundle, config: HeuristicConfig): Flag[] {
  const { coalesceWindowMs, highSeverityCharsChanged } = config.externalEdits;

  const externalEvents = index.byKind.get('fs.external_change') ?? [];

  // Separate by file, collecting only unexplained events.
  const unexplainedByFile = new Map<string, IndexedEvent[]>();
  for (const e of externalEvents) {
    if (isExplained(e.payload)) continue;
    const file = getFilePath(e.payload);
    let arr = unexplainedByFile.get(file);
    if (arr === undefined) {
      arr = [];
      unexplainedByFile.set(file, arr);
    }
    arr.push(e);
  }

  const flags: Flag[] = [];
  let flagIndex = 0;

  for (const [file, events] of unexplainedByFile) {
    // Events within a file are already in chronological order (byFile is ordered).
    const groups = coalesceGroups(events, coalesceWindowMs);

    for (const group of groups) {
      const severity: Severity = group.maxDiffSize > highSeverityCharsChanged ? 'high' : 'medium';

      const supportingSeqs = group.events.map((e) => `${e.sessionId}:${e.seq}`);
      const seqKey0 = supportingSeqs[0]!;
      const id = flagId(seqKey0, flagIndex++);

      const eventCount = group.events.length;
      const plural = eventCount === 1 ? 'change' : 'changes';

      flags.push({
        id,
        heuristic: 'external_edits',
        title: `Unexplained external edit(s) in ${file}`,
        severity,
        confidence: CONFIDENCE,
        supportingSeqs,
        description:
          `${eventCount} unexplained external file ${plural} detected in ${file}` +
          (group.maxDiffSize > 0 ? ` (max ±${group.maxDiffSize} chars).` : '.'),
        detail: {
          file,
          eventCount,
          maxDiffSize: group.maxDiffSize,
          seqs: supportingSeqs,
        },
      });
    }
  }

  return flags;
}

export const externalEditsHeuristic: Heuristic = {
  id: 'external_edits',
  label: 'Unexplained external edits',
  run,
};
