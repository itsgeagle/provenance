/**
 * ai_extension_active heuristic (Phase 17).
 *
 * PRD §7.4 environment: "An AI coding-assistant extension is active during the
 * session (either installed at session start or activated mid-session)."
 *
 * Reads two event kinds:
 *   1. ext.snapshot — taken at session start; lists all installed + enabled
 *      extensions. Any enabled extension classified as an AI assistant triggers
 *      this heuristic.
 *   2. ext.activate — fired when an extension activates at runtime. Any
 *      activation of an AI extension (not already reported via snapshot) also
 *      triggers this heuristic.
 *
 * Detection is two-tiered (hybrid), sharing the same id-based classifier as the
 * display-only "Active extensions" card (`extensions/detect-ai-extension.ts`):
 *   - **Curated tier (confidence 0.9):** the id is on the course AI-tool list
 *     (`config/ai-extension-list.json`, staff-editable via HeuristicConfig) OR
 *     in the classifier's built-in curated set. A reliable signal.
 *   - **Token tier (confidence 0.6):** the id is not curated but matches an AI
 *     naming token (e.g. `copilot`, `claude`, `ai`, `gpt`). A weaker, heuristic
 *     signal, so it contributes proportionally less to the score.
 *
 * The course list is *additive* on top of the built-in classifier: emptying it
 * no longer disables detection. The detection reason and tier are carried into
 * the flag `detail` for reviewer triage.
 *
 * Severity: 'info'. The mere presence of an AI tool does not imply academic
 * dishonesty. Course staff decide what to do with the information.
 *
 * De-duplication: one flag per unique extension ID per session. If the same
 * extension appears in both a snapshot AND an activate event we emit one flag.
 */

import type { EventIndex } from '../index/event-index.js';
import type { Bundle } from '../loader/types.js';
import type { Flag, Heuristic } from './types.js';
import type { HeuristicConfig } from './config.js';
import { detectAiExtension } from '../extensions/detect-ai-extension.js';
import defaultAiExtensionList from './config/ai-extension-list.json' with { type: 'json' };

// ---------------------------------------------------------------------------
// Confidence tiers
// ---------------------------------------------------------------------------

/** Curated id (course list or built-in curated set): a reliable signal. */
const CURATED_CONFIDENCE = 0.9;
/** Token-only match (id naming pattern): a weaker, heuristic signal. */
const TOKEN_CONFIDENCE = 0.6;

type AiClassification = {
  confidence: number;
  reason: string;
  tier: 'curated' | 'token';
};

/**
 * Classify an extension id as AI or not, combining the staff-editable course
 * list (curated tier) with the built-in id classifier (curated set → curated
 * tier; token pattern → token tier). Returns null when the id is not AI.
 */
function classifyAiExtension(id: string, courseListIds: Set<string>): AiClassification | null {
  if (courseListIds.has(id)) {
    return { confidence: CURATED_CONFIDENCE, reason: 'on course AI-tool list', tier: 'curated' };
  }
  const detection = detectAiExtension(id);
  if (!detection.isAi) return null;
  if (detection.reason === 'known AI extension') {
    return { confidence: CURATED_CONFIDENCE, reason: detection.reason, tier: 'curated' };
  }
  return {
    confidence: TOKEN_CONFIDENCE,
    reason: detection.reason ?? 'matches an AI naming token',
    tier: 'token',
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function flagId(sessionId: string, extId: string): string {
  // Sanitize the extension ID (dots/slashes could break downstream parsing).
  const safeExtId = extId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `ai_extension_active-${sessionId}-${safeExtId}`;
}

/** Build the flag for one detected AI extension. */
function buildFlag(
  sessionId: string,
  id: string,
  version: string,
  detectedVia: 'ext.snapshot' | 'ext.activate',
  supportingSeq: string,
  classification: AiClassification,
): Flag {
  const where = detectedVia === 'ext.snapshot' ? 'was enabled at session start' : 'activated';
  const signal =
    classification.tier === 'curated'
      ? `This is a recognized AI coding assistant (${classification.reason}).`
      : `Its id matches an AI-tool naming pattern (${classification.reason}) — a weaker signal; ` +
        `verify it is actually an AI assistant.`;
  return {
    id: flagId(sessionId, id),
    heuristic: 'ai_extension_active',
    title:
      detectedVia === 'ext.snapshot'
        ? `AI extension active at session start: ${id}`
        : `AI extension activated: ${id}`,
    severity: 'info',
    confidence: classification.confidence,
    supportingSeqs: [supportingSeq],
    description:
      `The extension "${id}" (v${version}) ${where}. ${signal} ` +
      `Informational only — review session context to determine if AI assistance was used ` +
      `inappropriately.`,
    detail: {
      extensionId: id,
      version,
      detectedVia,
      sessionId,
      aiReason: classification.reason,
      matchTier: classification.tier,
    },
  };
}

// ---------------------------------------------------------------------------
// Heuristic implementation
// ---------------------------------------------------------------------------

function run(index: EventIndex, _bundle: Bundle, config: HeuristicConfig): Flag[] {
  const courseListIds = new Set<string>(config.aiExtensionActive.knownAiExtensions);
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
        if (flaggedInSession.has(id)) continue;
        const classification = classifyAiExtension(id, courseListIds);
        if (classification === null) continue;

        flaggedInSession.add(id);
        const version = typeof ext['version'] === 'string' ? ext['version'] : 'unknown';
        flags.push(
          buildFlag(
            sessionId,
            id,
            version,
            'ext.snapshot',
            `${ev.sessionId}:${ev.seq}`,
            classification,
          ),
        );
      }
    }

    // --- ext.activate events ---
    const activateEvents = sessionEvents.filter((e) => e.kind === 'ext.activate');
    for (const ev of activateEvents) {
      const payload = ev.payload as Record<string, unknown> | null;
      const id = payload?.['id'];
      if (typeof id !== 'string') continue;
      if (flaggedInSession.has(id)) continue;
      const classification = classifyAiExtension(id, courseListIds);
      if (classification === null) continue;

      flaggedInSession.add(id);
      const version = typeof payload?.['version'] === 'string' ? payload['version'] : 'unknown';
      flags.push(
        buildFlag(
          sessionId,
          id,
          version,
          'ext.activate',
          `${ev.sessionId}:${ev.seq}`,
          classification,
        ),
      );
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
