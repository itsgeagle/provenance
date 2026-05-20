/**
 * ai_extension_active heuristic (Phase 17).
 *
 * PRD §7.4 environment: "An AI coding-assistant extension is active during the
 * session (either installed at session start or activated mid-session)."
 *
 * Reads two event kinds:
 *   1. ext.snapshot — taken at session start; lists all installed + enabled
 *      extensions. Any extension whose `id` is in the AI-extension allowlist
 *      and whose `enabled` flag is true triggers this heuristic.
 *   2. ext.activate — fired when an extension activates at runtime. Any
 *      activation of a known AI extension (not already reported via snapshot)
 *      also triggers this heuristic.
 *
 * Severity: 'info'. This is an informational signal — the mere presence of an
 * AI tool does not imply academic dishonesty. Course staff decide what to do
 * with the information.
 *
 * Confidence: 0.9 — the extension ID is a reliable signal. Near-certainty that
 * the reported extension is actually active.
 *
 * Config: The `knownAiExtensions` list is loaded from
 * `config/ai-extension-list.json` by default but can be overridden via
 * HeuristicConfig for tests and course-staff customization.
 *
 * De-duplication: one flag per unique extension ID per session. If the same
 * extension appears in both a snapshot AND an activate event we emit one flag.
 */

import type { EventIndex } from '../index/event-index.js';
import type { Bundle } from '../loader/types.js';
import type { Flag, Heuristic } from './types.js';
import type { HeuristicConfig } from './config.js';
import defaultAiExtensionList from './config/ai-extension-list.json';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function flagId(sessionId: string, extId: string): string {
  // Sanitize the extension ID (dots/slashes could break downstream parsing).
  const safeExtId = extId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `ai_extension_active-${sessionId}-${safeExtId}`;
}

// ---------------------------------------------------------------------------
// Heuristic implementation
// ---------------------------------------------------------------------------

function run(index: EventIndex, _bundle: Bundle, config: HeuristicConfig): Flag[] {
  const knownIds = new Set<string>(config.aiExtensionActive.knownAiExtensions);
  const flags: Flag[] = [];

  for (const [sessionId, sessionEvents] of index.bySessionId) {
    // Track which extension IDs we've already flagged in this session so we
    // don't emit duplicates when an extension appears in both snapshot + activate.
    const flaggedInSession = new Set<string>();

    // --- ext.snapshot events ---
    const snapshotEvents = sessionEvents.filter((e) => e.kind === 'ext.snapshot');
    for (const ev of snapshotEvents) {
      const payload = ev.payload as Record<string, unknown> | null;
      const extensions = payload?.['extensions'];
      if (!Array.isArray(extensions)) continue;

      for (const ext of extensions as Array<Record<string, unknown>>) {
        const id = ext['id'];
        const enabled = ext['enabled'];
        if (typeof id !== 'string' || enabled !== true) continue;
        if (!knownIds.has(id) || flaggedInSession.has(id)) continue;

        flaggedInSession.add(id);
        const version = typeof ext['version'] === 'string' ? ext['version'] : 'unknown';
        flags.push({
          id: flagId(sessionId, id),
          heuristic: 'ai_extension_active',
          title: `AI extension active at session start: ${id}`,
          severity: 'info',
          confidence: 0.9,
          supportingSeqs: [`${ev.sessionId}:${ev.seq}`],
          description:
            `The extension "${id}" (v${version}) was installed and enabled at session start. ` +
            `This extension is on the course AI-tool list. Informational only — review session ` +
            `context to determine if AI assistance was used inappropriately.`,
          detail: { extensionId: id, version, detectedVia: 'ext.snapshot', sessionId },
        });
      }
    }

    // --- ext.activate events ---
    const activateEvents = sessionEvents.filter((e) => e.kind === 'ext.activate');
    for (const ev of activateEvents) {
      const payload = ev.payload as Record<string, unknown> | null;
      const id = payload?.['id'];
      if (typeof id !== 'string') continue;
      if (!knownIds.has(id) || flaggedInSession.has(id)) continue;

      flaggedInSession.add(id);
      const version = typeof payload?.['version'] === 'string' ? payload['version'] : 'unknown';
      flags.push({
        id: flagId(sessionId, id),
        heuristic: 'ai_extension_active',
        title: `AI extension activated: ${id}`,
        severity: 'info',
        confidence: 0.9,
        supportingSeqs: [`${ev.sessionId}:${ev.seq}`],
        description:
          `The extension "${id}" (v${version}) activated during this session. ` +
          `This extension is on the course AI-tool list. Informational only — review session ` +
          `context to determine if AI assistance was used inappropriately.`,
        detail: { extensionId: id, version, detectedVia: 'ext.activate', sessionId },
      });
    }
  }

  return flags;
}

export const aiExtensionActiveHeuristic: Heuristic = {
  id: 'ai_extension_active',
  label: 'AI extension active during session',
  run,
};

/** Default AI extension IDs loaded from the committed JSON list. */
export const DEFAULT_AI_EXTENSION_IDS: readonly string[] =
  defaultAiExtensionList.extensionIds as string[];
