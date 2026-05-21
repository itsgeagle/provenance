/**
 * reconstructFile — apply doc.change / paste / fs.external_change events to
 * reproduce the in-memory content of a file at a given point in time (Phase 3).
 *
 * PRD §7.3, §4.5.
 *
 * v2 extension point (Phase 12):
 *   This file will gain `reconstructFileWithProvenance()` which layers per-
 *   character "last touched by event" tracking on top of the apply-deltas loop.
 *   The `applyDocChange` and `applyPaste` helpers are kept as separate pure
 *   functions so Phase 12 can replace them with provenance-tracked variants
 *   without rewriting the event-dispatch switch.
 */

import type { DocChangeDelta, Range } from '@provenance/log-core';
import type { EventIndex } from './event-index.js';

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export type TaintReason = 'fs_external_change' | 'large_paste';

export type TaintEntry = {
  globalIdx: number;
  reason: TaintReason;
};

/**
 * The result of reconstructing a file's content.
 *
 * `content` is best-effort. It is accurate as long as no taint has been
 * encountered; after a taint event (fs.external_change or a large paste > 4 KB
 * with no inline content), `content` is reset to `''` and should not be
 * treated as the true file content.
 *
 * `hashBySaveSeq` is always populated regardless of taint; the sha256 values
 * come directly from doc.save events and are not derived from `content`.
 *
 * `tainted` and `taintReasons` expose which events caused reconstruction to
 * become unreliable, for downstream consumers (Phase 4 heuristics, Phase 12
 * replay). Once tainted, the file stays tainted for the rest of the
 * reconstruction window — there is no "untaint" on doc.save in v1.
 *
 * v2 extension: this type will gain optional fields (e.g. a per-character
 * provenance map) without breaking callers that don't use them.
 */
export type ReconstructResult = {
  content: string;
  /** Maps `${sessionId}:${seq}` to the sha256 recorded at that save event. */
  hashBySaveSeq: Map<string, string>;
  /** True if any fs.external_change or large paste was encountered. */
  tainted: boolean;
  /** One entry per taint event, in globalIdx order. */
  taintReasons: TaintEntry[];
};

// ---------------------------------------------------------------------------
// String content model helpers
// ---------------------------------------------------------------------------

/**
 * Convert a line/character position to a flat string offset.
 * Clamps character to the actual line length.
 */
function positionToOffset(content: string, line: number, character: number): number {
  const lines = content.split('\n');
  let offset = 0;
  for (let l = 0; l < line && l < lines.length; l++) {
    offset += (lines[l]?.length ?? 0) + 1; // +1 for the '\n'
  }
  const targetLine = lines[line] ?? '';
  offset += Math.min(character, targetLine.length);
  return Math.min(offset, content.length);
}

/**
 * Applies a doc.change payload's deltas to the content string.
 *
 * IMPORTANT: VS Code emits `contentChanges` in reverse document order — bottom-
 * to-top, rightmost-first — so each delta's `range` is valid against the
 * pre-mutation document state. The recorder stores deltas in that order
 * verbatim, and this function applies them in array order. Do not sort or
 * reorder; the recorder/analyzer contract relies on this.
 *
 * v2 extension point: Phase 12 will replace this with a version that also
 * records, for each character in the output, the globalIdx of the event that
 * last wrote it.
 */
export function applyDocChange(content: string, payload: unknown): string {
  // Narrow payload — it must have a `deltas` array of DocChangeDelta objects.
  if (typeof payload !== 'object' || payload === null) return content;
  const p = payload as Record<string, unknown>;
  const deltas = p['deltas'];
  if (!Array.isArray(deltas)) return content;

  let result = content;
  for (const delta of deltas as DocChangeDelta[]) {
    const start = positionToOffset(result, delta.range.start.line, delta.range.start.character);
    const end = positionToOffset(result, delta.range.end.line, delta.range.end.character);
    result = result.slice(0, start) + delta.text + result.slice(end);
  }
  return result;
}

/**
 * Apply a paste to a content string.
 *
 * Returns the modified content and a flag indicating whether the paste was
 * applied (false = large paste with no inline content → caller should taint).
 *
 * v2 extension point: Phase 12 will replace this with a version that tracks
 * per-character provenance.
 */
export function applyPaste(
  content: string,
  payload: unknown,
): { content: string; applied: boolean } {
  if (typeof payload !== 'object' || payload === null) {
    return { content, applied: false };
  }
  const p = payload as Record<string, unknown>;

  // Only inline pastes (content field present) can be applied.
  // Pastes > 4 KB only record head/tail/length/sha256, not the full text.
  if (typeof p['content'] !== 'string') {
    return { content, applied: false };
  }

  const rangeRaw = p['range'];
  if (typeof rangeRaw !== 'object' || rangeRaw === null) {
    return { content, applied: false };
  }
  const range = rangeRaw as Range;

  const text = p['content'] as string;
  const start = positionToOffset(content, range.start.line, range.start.character);
  const end = positionToOffset(content, range.end.line, range.end.character);
  return {
    content: content.slice(0, start) + text + content.slice(end),
    applied: true,
  };
}

// ---------------------------------------------------------------------------
// reconstructFile
// ---------------------------------------------------------------------------

/**
 * Reconstruct the content of `filePath` by replaying its events from the
 * beginning (or up to `upToGlobalIdx`, exclusive).
 *
 * Only events in `index.byFile.get(filePath)` are considered, which are
 * already in chronological order (globalIdx ascending).
 *
 * Reconstruction semantics:
 *  - `doc.open`   — if the payload has a `content` field (recorder v1.1+),
 *                   seeds the running content from it. Pre-v1.1 payloads
 *                   have no content field; reconstruction starts from ''.
 *  - `doc.close`  — ignored; content keeps accumulating (we want final state).
 *  - `doc.change` — apply deltas via applyDocChange.
 *  - `paste`      — apply via applyPaste if inline; otherwise taint.
 *  - `fs.external_change` — if the payload carries `new_content` (recorder
 *                            v1.3+), reseed `content` from it and continue
 *                            reconstruction unimpeded; `taintReasons` still
 *                            records the event. Without `new_content`, reset
 *                            content to '' and taint the file.
 *  - `doc.save`   — record sha256 in hashBySaveSeq; verify vs computed hash
 *                   in the perf/exit-gate test (see build-index.test.ts).
 *
 * Once tainted, the file stays tainted for the entire reconstruction window
 * (v1 policy — see notes in task description). hashBySaveSeq keeps recording
 * saves so callers always have the recorded hash even when content is stale.
 */
export function reconstructFile(
  index: EventIndex,
  filePath: string,
  upToGlobalIdx?: number,
): ReconstructResult {
  let content = '';
  const hashBySaveSeq = new Map<string, string>();
  let tainted = false;
  const taintReasons: TaintEntry[] = [];

  const fileEvents = index.byFile.get(filePath) ?? [];

  for (const e of fileEvents) {
    // upToGlobalIdx is exclusive: stop before processing this event.
    if (upToGlobalIdx !== undefined && e.globalIdx >= upToGlobalIdx) break;

    // v2 extension point: after the switch, Phase 12's provenance-tracked
    // loop will update a per-character attribution array here.
    switch (e.kind) {
      case 'doc.open': {
        // Recorder v1.1+ includes the file's initial content in the payload
        // (≤ 64 KB). When present, seed the running content from it so that
        // subsequent deltas resolve against the correct baseline.
        //
        // Pre-v1.1 doc.open events have no content field — analyzer cannot
        // recover initial content and reconstruction starts from ''.
        const p = e.payload as Record<string, unknown> | null;
        if (typeof p?.['content'] === 'string') {
          content = p['content'];
        }
        break;
      }

      case 'doc.close':
        // Ignored for content reconstruction.
        break;

      case 'doc.change':
        if (!tainted) {
          content = applyDocChange(content, e.payload);
        }
        break;

      case 'paste': {
        if (!tainted) {
          const result = applyPaste(content, e.payload);
          if (result.applied) {
            content = result.content;
          } else {
            // Large paste (> 4 KB, no inline content) — taint.
            tainted = true;
            taintReasons.push({ globalIdx: e.globalIdx, reason: 'large_paste' });
            content = '';
          }
        }
        break;
      }

      case 'fs.external_change': {
        // Recorder v1.3+ inlines the post-change content (≤ 4 KB) on the
        // payload's `new_content` field — PRD §4.5. When present, reseed
        // `content` so reconstruction stays accurate across the external
        // edit and the replay UI shows the post-change file. When absent
        // (large file, head/tail-only payload, or pre-v1.3 bundle), fall
        // back to the original taint-empty behavior.
        const p = e.payload as Record<string, unknown> | null;
        const newContent = typeof p?.['new_content'] === 'string' ? p['new_content'] : null;
        // taintReasons stays populated either way so consumers that want a
        // "this file had an external edit at globalIdx N" signal still see it.
        taintReasons.push({ globalIdx: e.globalIdx, reason: 'fs_external_change' });
        if (newContent !== null) {
          content = newContent;
          // Reconstruction IS valid post-reseed — subsequent doc.change /
          // paste events apply cleanly on top. Leave `tainted` unchanged.
        } else {
          tainted = true;
          content = '';
        }
        break;
      }

      case 'doc.save': {
        // Always record the save hash; it comes directly from the recorder.
        const p = e.payload as Record<string, unknown> | null;
        const sha256 = typeof p?.['sha256'] === 'string' ? p['sha256'] : '';
        hashBySaveSeq.set(`${e.sessionId}:${e.seq}`, sha256);
        break;
      }

      default:
        // selection.change, focus.change, etc. — not relevant to content.
        break;
    }
  }

  return { content, hashBySaveSeq, tainted, taintReasons };
}
