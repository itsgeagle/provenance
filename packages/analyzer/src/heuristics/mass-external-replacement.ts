/**
 * mass_external_replacement heuristic (Phase 16).
 *
 * PRD §7.4 process-shape: "fs.external_change where the new content shares
 * <20% lines with the old."
 *
 * The fs.external_change payload only carries `old_hash`/`new_hash`/`diff_size`
 * — never the full pre- or post-change file content. To compare old vs new, we
 * use the reconstructed content *immediately before* the external_change event.
 * The post-change content is unavailable (the payload lacks it), so we use the
 * next save's reconstructed content as the proxy for "what came after."
 *
 * Degradation strategy:
 *   - If no pre-change content is available (e.g., the first event for the file
 *     is an external_change, or reconstruction is tainted), skip the event.
 *   - If no post-change content is recoverable (no subsequent save), skip the
 *     event — we cannot compute the overlap ratio.
 *
 * Severity: 'high' (full replacement of file content by an external actor).
 * Confidence: 0.75 (we're using a proxy for post-change content).
 *
 * Threshold: sharedLines / max(oldLines, postLines) < massExternalReplacement.sharedThreshold.
 */

import { diffLines } from 'diff';
import type { EventIndex } from '../index/event-index.js';
import type { Bundle } from '../loader/types.js';
import type { Flag, Heuristic } from './types.js';
import type { HeuristicConfig } from './config.js';
import { reconstructFileWithProvenance } from '../index/reconstruct-file-provenance.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Count shared (unchanged) lines between two text strings via diffLines().
 * Returns 0 when either string is empty.
 */
function sharedLineCount(textA: string, textB: string): number {
  if (textA.length === 0 || textB.length === 0) return 0;
  const parts = diffLines(textA, textB);
  let shared = 0;
  for (const part of parts) {
    if (!part.added && !part.removed) {
      shared += part.count ?? 0;
    }
  }
  return shared;
}

function lineCount(text: string): number {
  if (text.length === 0) return 0;
  return text.split('\n').length;
}

function flagId(seqKey: string, idx: number): string {
  return `mass_external_replacement-${seqKey}-${idx}`;
}

// ---------------------------------------------------------------------------
// Heuristic implementation
// ---------------------------------------------------------------------------

/**
 * Build a map from filePath → ordered list of doc.save globalIdx values.
 * Used to find the next save after an external_change event.
 */
function buildSaveGlobalIdxByFile(index: EventIndex): Map<string, number[]> {
  const saveEvents = index.byKind.get('doc.save') ?? [];
  const result = new Map<string, number[]>();
  for (const e of saveEvents) {
    const p = e.payload as Record<string, unknown> | null;
    const path = typeof p?.['path'] === 'string' ? (p['path'] as string) : undefined;
    if (path === undefined) continue;
    let arr = result.get(path);
    if (arr === undefined) {
      arr = [];
      result.set(path, arr);
    }
    arr.push(e.globalIdx);
  }
  // Each array is in ascending globalIdx order (byKind is ordered).
  return result;
}

/**
 * Find the first globalIdx in `sortedIdxList` that is strictly greater than
 * `afterGlobalIdx`. Returns undefined if none found.
 */
function firstAfter(sortedIdxList: number[], afterGlobalIdx: number): number | undefined {
  for (const gi of sortedIdxList) {
    if (gi > afterGlobalIdx) return gi;
  }
  return undefined;
}

function getFilePath(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const p = payload as Record<string, unknown>;
  return typeof p['path'] === 'string' ? (p['path'] as string) : undefined;
}

function run(index: EventIndex, _bundle: Bundle, config: HeuristicConfig): Flag[] {
  const threshold = config.massExternalReplacement.sharedThreshold;

  const externalEvents = index.byKind.get('fs.external_change') ?? [];
  if (externalEvents.length === 0) return [];

  const saveGlobalIdxByFile = buildSaveGlobalIdxByFile(index);

  // Cache reconstructed content at specific globalIdx boundaries.
  const reconstructionCache = new Map<string, string>();

  function getContentAt(filePath: string, upToGlobalIdx: number): string {
    const cacheKey = `${filePath}:${upToGlobalIdx}`;
    const cached = reconstructionCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const state = reconstructFileWithProvenance(index, filePath, upToGlobalIdx);
    reconstructionCache.set(cacheKey, state.content);
    return state.content;
  }

  const flags: Flag[] = [];
  let flagIndex = 0;

  for (const e of externalEvents) {
    const filePath = getFilePath(e.payload);
    if (filePath === undefined) continue;

    // Pre-change content: reconstruct up to (but not including) this event.
    const preContent = getContentAt(filePath, e.globalIdx);

    // If we have no pre-content at all (empty before first save, tainted, etc.),
    // skip — we cannot compute a meaningful overlap ratio.
    if (preContent.length === 0) continue;

    // Post-change content: use the content at the next save after this event,
    // by reconstructing up to just past that save's globalIdx (exclusive = +1).
    const saveIdxList = saveGlobalIdxByFile.get(filePath);
    const nextSaveGi = saveIdxList !== undefined ? firstAfter(saveIdxList, e.globalIdx) : undefined;

    if (nextSaveGi === undefined) {
      // No subsequent save found; cannot determine post-change content.
      continue;
    }

    // Reconstruct through and including the next save (upTo = nextSaveGi + 1).
    const postContent = getContentAt(filePath, nextSaveGi + 1);

    if (postContent.length === 0) continue;

    const oldLines = lineCount(preContent);
    const newLines = lineCount(postContent);
    const denominator = Math.max(oldLines, newLines);
    if (denominator === 0) continue;

    const shared = sharedLineCount(preContent, postContent);
    const ratio = shared / denominator;

    if (ratio >= threshold) continue; // not a mass replacement

    const seqKey = `${e.sessionId}:${e.seq}`;
    const id = flagId(seqKey, flagIndex++);

    flags.push({
      id,
      heuristic: 'mass_external_replacement',
      title: `Mass external replacement of ${filePath}`,
      severity: 'high',
      confidence: 0.75,
      supportingSeqs: [seqKey],
      description:
        `An external change to ${filePath} replaced ${Math.round((1 - ratio) * 100)}% ` +
        `of the file's lines (${shared}/${denominator} lines shared with post-change content).`,
      detail: {
        filePath,
        sharedLines: shared,
        oldLines,
        newLines,
        overlapRatio: ratio,
        threshold,
      },
    });
  }

  return flags;
}

export const massExternalReplacementHeuristic: Heuristic = {
  id: 'mass_external_replacement',
  label: 'Mass external replacement',
  run,
};
