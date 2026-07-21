/**
 * time_to_first_save_anomaly heuristic (Phase 16).
 *
 * PRD §7.4 process-shape: "<30s from doc.open to a doc.save containing
 * >500 chars of new code."
 *
 * For each file, we find the first doc.open event and the first doc.save event
 * that follows it. If:
 *   - The save arrives within `anomalySeconds` seconds (default: 30), AND
 *   - The reconstructed file content at the save point has > `minChars`
 *     characters (default: 500)
 * then we emit a flag.
 *
 * We measure elapsed time using the `t` field (ms since session start) for
 * events within the same session. When doc.open and doc.save are in the same
 * session, this is exact. We do not attempt cross-session measurement (the `t`
 * fields are not comparable across sessions).
 *
 * Content at the save point is obtained by counting characters in the
 * reconstructed content (upToGlobalIdx = globalIdx of the save event + 1).
 * This counts only typed + inline-paste content — large pastes (over the recorder's inline cap, no
 * inline content) and external changes clear the reconstruction, so we skip
 * tainted reconstructions (empty content).
 *
 * Severity: high. Confidence: 0.8.
 */

import type { EventIndex } from '../index/event-index.js';
import type { Bundle } from '../loader/types.js';
import type { Flag, Heuristic } from './types.js';
import type { HeuristicConfig } from './config.js';
import { reconstructFileWithProvenance } from '../index/reconstruct-file-provenance.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function flagId(seqKey: string, idx: number): string {
  return `time_to_first_save_anomaly-${seqKey}-${idx}`;
}

// ---------------------------------------------------------------------------
// Heuristic implementation
// ---------------------------------------------------------------------------

function run(index: EventIndex, _bundle: Bundle, config: HeuristicConfig): Flag[] {
  const { anomalySeconds, minChars } = config.timeToFirstSaveAnomaly;
  const anomalyMs = anomalySeconds * 1000;

  const flags: Flag[] = [];
  let flagIndex = 0;

  // Operate per file: find first doc.open per file, then find first doc.save
  // in the same session after the open.
  const openEvents = index.byKind.get('doc.open') ?? [];
  const saveEvents = index.byKind.get('doc.save') ?? [];

  // Build a lookup: filePath → ordered list of {t, globalIdx, sessionId} for saves.
  type SaveEntry = { t: number; globalIdx: number; sessionId: string; seq: number };
  const savesByFile = new Map<string, SaveEntry[]>();
  for (const e of saveEvents) {
    const p = e.payload as Record<string, unknown> | null;
    const path = typeof p?.['path'] === 'string' ? (p['path'] as string) : undefined;
    if (path === undefined) continue;
    let arr = savesByFile.get(path);
    if (arr === undefined) {
      arr = [];
      savesByFile.set(path, arr);
    }
    arr.push({ t: e.t, globalIdx: e.globalIdx, sessionId: e.sessionId, seq: e.seq });
  }

  // Track files we've already checked (flag only on first anomaly per file per session-open).
  const checkedKey = new Set<string>();

  for (const openEvent of openEvents) {
    const p = openEvent.payload as Record<string, unknown> | null;
    const filePath = typeof p?.['path'] === 'string' ? (p['path'] as string) : undefined;
    if (filePath === undefined) continue;

    const checkKey = `${openEvent.sessionId}:${filePath}:${openEvent.seq}`;
    if (checkedKey.has(checkKey)) continue;
    checkedKey.add(checkKey);

    const saves = savesByFile.get(filePath);
    if (saves === undefined || saves.length === 0) continue;

    // Find the first doc.save in the same session after this open (by globalIdx).
    const firstSave = saves.find(
      (s) => s.sessionId === openEvent.sessionId && s.globalIdx > openEvent.globalIdx,
    );
    if (firstSave === undefined) continue;

    // Check elapsed time within this session (t is session-local monotonic ms).
    const elapsedMs = firstSave.t - openEvent.t;
    if (elapsedMs >= anomalyMs) continue;

    // Check content size at the save point. upToGlobalIdx = firstSave.globalIdx + 1
    // (include the save event so hashBySaveSeq is populated, but content is the same
    // as just before the save — doc.save doesn't change content).
    const state = reconstructFileWithProvenance(index, filePath, firstSave.globalIdx + 1);

    // Skip tainted (empty) reconstructions — cannot reliably count chars.
    if (state.content.length === 0) continue;
    if (state.content.length <= minChars) continue;

    const openSeqKey = `${openEvent.sessionId}:${openEvent.seq}`;
    const saveSeqKey = `${firstSave.sessionId}:${firstSave.seq}`;
    const id = flagId(openSeqKey, flagIndex++);

    flags.push({
      id,
      heuristic: 'time_to_first_save_anomaly',
      title: `File saved ${elapsedMs < 1000 ? `${elapsedMs}ms` : `${Math.round(elapsedMs / 1000)}s`} after open in ${filePath}`,
      severity: 'high',
      confidence: 0.8,
      supportingSeqs: [openSeqKey, saveSeqKey],
      description:
        `${filePath} was saved ${Math.round(elapsedMs / 1000)}s after opening, ` +
        `with ${state.content.length} characters of content. ` +
        `Expected at least ${anomalySeconds}s for genuine typing of ${minChars}+ chars.`,
      detail: {
        filePath,
        elapsedMs,
        anomalySeconds,
        contentLength: state.content.length,
        minChars,
      },
    });
  }

  return flags;
}

export const timeToFirstSaveAnomalyHeuristic: Heuristic = {
  id: 'time_to_first_save_anomaly',
  label: 'Anomalously fast first save',
  run,
};
