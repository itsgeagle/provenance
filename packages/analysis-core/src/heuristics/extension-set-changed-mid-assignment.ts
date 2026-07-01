/**
 * extension_set_changed_mid_assignment heuristic (Phase 17).
 *
 * PRD §7.4 environment: "A known AI extension was activated mid-assignment
 * (i.e., after the session had already started)."
 *
 * The distinction from `ai_extension_active`: that heuristic fires for any AI
 * tool present at session start OR activated at any time. This heuristic fires
 * specifically when the AI extension appears via `ext.activate` (not
 * `ext.snapshot`) — meaning it was not listed in the session-start snapshot,
 * but became active during the session. This is a stronger signal: the student
 * may have deliberately activated an AI tool mid-session.
 *
 * Implementation:
 *   1. Collect all extension IDs visible in ext.snapshot events for the session.
 *   2. Collect all ext.activate events for known AI tools.
 *   3. Flag any activate event for an ID that was NOT in the session-start snapshot.
 *
 * Severity: 'medium'. Confidence: 0.85.
 * (Stronger than ai_extension_active because mid-session activation is more
 * deliberate. Still not high because legitimate reasons exist — e.g., VS Code
 * auto-installing a recommended extension.)
 */

import type { EventIndex } from '../index/event-index.js';
import type { Bundle } from '../loader/types.js';
import type { Flag, Heuristic } from './types.js';
import type { HeuristicConfig } from './config.js';
import defaultAiExtensionList from './config/ai-extension-list.json' with { type: 'json' };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function flagId(sessionId: string, extId: string, seq: number): string {
  const safeExtId = extId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `extension_set_changed_mid_assignment-${sessionId}-${safeExtId}-${seq}`;
}

// ---------------------------------------------------------------------------
// Heuristic implementation
// ---------------------------------------------------------------------------

function run(index: EventIndex, _bundle: Bundle, config: HeuristicConfig): Flag[] {
  const knownIds = new Set<string>(config.aiExtensionActive.knownAiExtensions);
  const flags: Flag[] = [];

  for (const [sessionId, sessionEvents] of index.bySessionId) {
    // Step 1: collect extension IDs visible at session start via ext.snapshot.
    const snapshotIds = new Set<string>();
    for (const ev of sessionEvents.filter((e) => e.kind === 'ext.snapshot')) {
      const payload = ev.payload as Record<string, unknown> | null;
      const extensions = payload?.['extensions'];
      if (!Array.isArray(extensions)) continue;
      for (const ext of extensions as Array<Record<string, unknown>>) {
        const id = ext['id'];
        if (typeof id === 'string') snapshotIds.add(id);
      }
    }

    // Step 2: find ext.activate events for known AI tools that weren't in the
    // session-start snapshot.
    const activateEvents = sessionEvents.filter((e) => e.kind === 'ext.activate');
    for (const ev of activateEvents) {
      const payload = ev.payload as Record<string, unknown> | null;
      const id = payload?.['id'];
      if (typeof id !== 'string') continue;
      if (!knownIds.has(id)) continue;
      if (snapshotIds.has(id)) continue; // Was present at start — not "mid-assignment"

      const version = typeof payload?.['version'] === 'string' ? payload['version'] : 'unknown';

      flags.push({
        id: flagId(sessionId, id, ev.seq),
        heuristic: 'extension_set_changed_mid_assignment',
        title: `AI extension activated mid-session: ${id}`,
        severity: 'medium',
        confidence: 0.85,
        supportingSeqs: [`${ev.sessionId}:${ev.seq}`],
        description:
          `The extension "${id}" (v${version}) was NOT present in the session-start ` +
          `extension snapshot but activated mid-session. This suggests the AI tool ` +
          `was deliberately enabled after the assignment session began.`,
        detail: {
          extensionId: id,
          version,
          sessionId,
          activatedAtSeq: ev.seq,
          activatedAtWall: ev.wall,
          wasInSnapshot: false,
        },
      });
    }
  }

  return flags;
}

export const extensionSetChangedMidAssignmentHeuristic: Heuristic = {
  id: 'extension_set_changed_mid_assignment',
  label: 'AI extension activated mid-assignment',
  run,
};

/** Re-export default list so tests can reference without importing JSON. */
export const DEFAULT_AI_EXTENSION_IDS: readonly string[] =
  defaultAiExtensionList.extensionIds as string[];
