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
// Line-cell content model (perf)
// ---------------------------------------------------------------------------
//
// `reconstructFile` replays a file's whole event stream. The exported
// `applyDocChange` / `applyPaste` helpers above keep a pure `(content, payload)`
// signature for their unit tests, but they re-split + rebuild the whole content
// string on every edit — O(content) per edit, which makes a full reconstruction
// O(L²) when edits land in the file interior (append-only streams stay cheap via
// V8 cons-strings, but template-fill assignments edit the interior). See
// `docs/ingest-complexity.md` "Known worst case".
//
// The hot loop below stores content as `cells: string[]` — the content split
// AFTER each '\n', so each cell carries its own trailing newline (the last cell
// may lack one). `content === cells.join('')`, and the number of cells equals
// the line count, so a (line, character) position maps directly to (cell index,
// char-in-cell) with no `lineStarts` array to maintain. A single-line in-place
// edit then touches one cell string — O(line length), with no array shift
// (splice replaces one cell with one). Only line-count-changing edits shift the
// cells array, and that moves pointers, not characters. The provenance variant
// in `reconstruct-file-provenance.ts` mirrors this model (kept in lockstep via
// `reconstruct-line-index.fuzz.test.ts`).

/** Split content into cells AFTER each '\n'. Always returns ≥1 cell. */
function splitCells(content: string): string[] {
  const cells: string[] = [];
  let start = 0;
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10 /* '\n' */) {
      cells.push(content.slice(start, i + 1));
      start = i + 1;
    }
  }
  cells.push(content.slice(start)); // final remainder (may be '' if content ended in '\n')
  return cells;
}

/** Running content as a line-cell array threaded through one reconstruction. */
type ContentBuf = { cells: string[] };

/** Clamped (cell index, char-in-cell) for a (line, character) position. */
type CellPos = { cell: number; char: number };

/**
 * Resolve a (line, character) position to a (cell, char-in-cell) pair, with the
 * exact clamping the old flat-offset `positionToOffset` used: line < 0 → start
 * of content; line ≥ line-count → end of content; otherwise character is clamped
 * to the visible line length (excluding the trailing '\n').
 */
function clampPos(cells: string[], line: number, character: number): CellPos {
  if (line < 0) return { cell: 0, char: 0 };
  if (line >= cells.length) {
    const last = cells.length - 1;
    return { cell: last, char: cells[last]!.length };
  }
  const cell = cells[line]!;
  const endsNL = cell.length > 0 && cell.charCodeAt(cell.length - 1) === 10;
  const visibleLen = endsNL ? cell.length - 1 : cell.length;
  return { cell: line, char: Math.min(character, visibleLen) };
}

/**
 * Splice `[start, end)` (in (cell, char) space) → `replacement` in `buf`,
 * maintaining the cell array. Mirrors the flat-string `slice + concat` exactly:
 * the merged prefix + replacement + suffix is re-split into cells, replacing the
 * spanned cells in place.
 */
function spliceCells(buf: ContentBuf, start: CellPos, end: CellPos, replacement: string): void {
  const isTail = end.cell === buf.cells.length - 1;
  const prefix = buf.cells[start.cell]!.slice(0, start.char);
  const suffix = buf.cells[end.cell]!.slice(end.char);
  const newCells = splitCells(prefix + replacement + suffix);
  // splitCells always emits a trailing remainder cell. When the spliced region
  // does NOT reach the document tail and the merged text ends in '\n', that
  // remainder is spurious — the real continuation is the untouched cell after
  // `end.cell`. Drop it. (A truly empty merge implies isTail, so this is safe.)
  if (!isTail && newCells.length > 1 && newCells[newCells.length - 1] === '') {
    newCells.pop();
  }
  buf.cells.splice(start.cell, end.cell - start.cell + 1, ...newCells);
}

/** Apply a doc.change payload's deltas to `buf` (in-place analogue of applyDocChange). */
function applyDocChangeBuf(buf: ContentBuf, payload: unknown): void {
  if (typeof payload !== 'object' || payload === null) return;
  const p = payload as Record<string, unknown>;
  const deltas = p['deltas'];
  if (!Array.isArray(deltas)) return;
  for (const delta of deltas as DocChangeDelta[]) {
    const start = clampPos(buf.cells, delta.range.start.line, delta.range.start.character);
    const end = clampPos(buf.cells, delta.range.end.line, delta.range.end.character);
    spliceCells(buf, start, end, delta.text);
  }
}

/**
 * Apply a paste payload to `buf` (in-place analogue of applyPaste). Returns
 * `false` for large pastes with no inline `content` — caller taints.
 */
function applyPasteBuf(buf: ContentBuf, payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) return false;
  const p = payload as Record<string, unknown>;
  if (typeof p['content'] !== 'string') return false;
  const rangeRaw = p['range'];
  if (typeof rangeRaw !== 'object' || rangeRaw === null) return false;
  const range = rangeRaw as Range;
  const text = p['content'] as string;
  const start = clampPos(buf.cells, range.start.line, range.start.character);
  const end = clampPos(buf.cells, range.end.line, range.end.character);
  spliceCells(buf, start, end, text);
  return true;
}

// ---------------------------------------------------------------------------
// reconstructFile
// ---------------------------------------------------------------------------

/**
 * Per-`EventIndex` memo of full-stream (no `upToGlobalIdx`) reconstructions,
 * shared across all consumers of one index (stats, heuristics) so the
 * full-stream replay happens once per file. Keyed weakly on the index so it is
 * released when the index is; never holds cut-point results (bounded memory).
 */
const finalReconstructionCache = new WeakMap<EventIndex, Map<string, ReconstructResult>>();

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
  // Full-stream reconstructions are requested by several consumers of the same
  // index (computeStats + low-typing-high-output). Memoize them per index so the
  // replay runs once. Cut-point (`upToGlobalIdx`) reconstructions are
  // detector-specific and rarely repeat, so they are not cached — that keeps
  // memory bounded when the replay UI seeks across many positions. All callers
  // treat the result as read-only.
  if (upToGlobalIdx === undefined) {
    const cached = finalReconstructionCache.get(index)?.get(filePath);
    if (cached !== undefined) return cached;
  }

  const buf: ContentBuf = { cells: [''] };
  const hashBySaveSeq = new Map<string, string>();
  let tainted = false;
  const taintReasons: TaintEntry[] = [];

  const fileEvents = index.byFile.get(filePath) ?? [];

  for (const e of fileEvents) {
    // upToGlobalIdx is exclusive: stop before processing this event.
    if (upToGlobalIdx !== undefined && e.globalIdx >= upToGlobalIdx) break;

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
          buf.cells = splitCells(p['content']);
        }
        break;
      }

      case 'doc.close':
        // Ignored for content reconstruction.
        break;

      case 'doc.change':
        if (!tainted) {
          applyDocChangeBuf(buf, e.payload);
        }
        break;

      case 'paste': {
        if (!tainted) {
          const applied = applyPasteBuf(buf, e.payload);
          if (!applied) {
            // Large paste (> 4 KB, no inline content) — taint.
            tainted = true;
            taintReasons.push({ globalIdx: e.globalIdx, reason: 'large_paste' });
            buf.cells = [''];
          }
        }
        break;
      }

      case 'fs.external_change': {
        // PRD §4.5. Recorder v1.3+ inlines the post-change content (≤ 4 KB)
        // and an optional `operation` discriminator ('modify' | 'delete' |
        // 'create', default 'modify' when absent).
        //
        // 'delete' or modify-without-content (large file / pre-v1.3
        // bundle) → clear content + taint. 'modify' or 'create' with
        // content → reseed; reconstruction stays valid (no taint).
        const p = e.payload as Record<string, unknown> | null;
        const operation =
          typeof p?.['operation'] === 'string' ? (p['operation'] as string) : 'modify';
        const newContent = typeof p?.['new_content'] === 'string' ? p['new_content'] : null;
        // taintReasons stays populated regardless so consumers that want a
        // "this file had an external edit at globalIdx N" signal still see it.
        taintReasons.push({ globalIdx: e.globalIdx, reason: 'fs_external_change' });
        if (operation === 'delete' || newContent === null) {
          tainted = true;
          buf.cells = [''];
        } else {
          buf.cells = splitCells(newContent);
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

  const result: ReconstructResult = {
    content: buf.cells.join(''),
    hashBySaveSeq,
    tainted,
    taintReasons,
  };
  if (upToGlobalIdx === undefined) {
    let perIndex = finalReconstructionCache.get(index);
    if (perIndex === undefined) {
      perIndex = new Map();
      finalReconstructionCache.set(index, perIndex);
    }
    perIndex.set(filePath, result);
  }
  return result;
}
