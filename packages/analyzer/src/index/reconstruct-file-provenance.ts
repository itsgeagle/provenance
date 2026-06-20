/**
 * reconstructFileWithProvenance — Phase 12.
 *
 * Layers per-character "last touched by event" tracking on top of v1's
 * apply-deltas loop. For every character in the reconstructed content, we
 * remember which event's `globalIdx` last wrote it. This is the foundation
 * for:
 *   - Phase 13–15 replay UI (gutter coloring + hover attribution per PRD §7.2)
 *   - Phase 16 `paste_is_solution` heuristic (compare paste payload vs final
 *     file state — PRD §7.4)
 *
 * Design choice (see A31 in `.notes/analyzer-progress.md`):
 *   v1's `reconstructFile` and this function are kept as **separate
 *   implementations**, not unified via a parameterized splice helper. The
 *   provenance variant needs to track a parallel `number[]` alongside the
 *   content string; threading that through a shared splice would force every
 *   caller (including v1's) through the same shape. Instead we re-implement
 *   the same algorithm here and add a property-based test that runs both
 *   functions on synthetic streams and asserts byte-identical `content` +
 *   identical `hashBySaveSeq`. The two paths thus stay in lockstep via tests
 *   rather than via code sharing.
 *
 * Performance: a full reconstruction is O(n) in the number of events for the
 * common append/local-edit stream (worst case O(n·lines) when edits land mid-
 * document and shift following line starts). The earlier implementation called
 * `content.split('\n')` on every position lookup — O(content length) per call,
 * twice per delta — which made reconstruction O(n²) and dominated ingest on
 * realistic bundles (see `.notes/ingest-perf-investigation.md`). We now keep an
 * incrementally-maintained `lineStarts` index so position→offset is O(1), and
 * mutate the `provenance` array in place rather than rebuilding it per delta.
 * The `provenance` array is frozen into a `Uint32Array` at the return boundary.
 */

import { diffLines } from 'diff';
import type { DocChangeDelta, Range } from '@provenance/log-core';
import type { EventIndex } from './event-index.js';

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/**
 * The kind tag we attribute to an event in `kindByGlobalIdx`. This is a
 * narrowed projection of `EventKind` covering only the events that can
 * actually write characters into a file's content.
 *
 * `'preexisting'` is set for `doc.open` events whose payload carries a
 * `content` field (recorder v1.1+). Every position in `provenance` seeded
 * from that initial content is attributed to the doc.open event's globalIdx.
 *
 * `'external_change'` is set for `fs.external_change` events. When the
 * payload carries `new_content` (recorder v1.3+), every character in the
 * reseeded file is attributed to that event's globalIdx. When it doesn't
 * (>4 KB file, pre-v1.3 bundle), the entry is a sentinel — no provenance
 * position references it and downstream UI sees an empty region.
 *
 * Future UI work (Phase 14 gutter coloring) could render preexisting
 * characters in a distinct color (e.g. greyed-out to indicate "not written
 * during this session").
 */
export type ProvenanceKind = 'typed' | 'paste' | 'external_change' | 'preexisting';

/**
 * State of a file at a given point in its event stream.
 *
 * Invariants:
 *  - `content.length === provenance.length` always.
 *  - Every value in `provenance` is the `globalIdx` of an event that appears
 *    in `kindByGlobalIdx`. (Initial empty state has empty provenance.)
 *  - `hashBySaveSeq` keyed by `${sessionId}:${seq}` of doc.save events, value
 *    is the sha256 from the doc.save payload (NOT computed from `content`).
 */
export type FileReplayState = {
  content: string;
  /**
   * Per-character attribution. `provenance[i]` is the `globalIdx` of the
   * event that last wrote `content[i]`. Length === content.length.
   */
  provenance: Uint32Array;
  /**
   * Maps a writing event's `globalIdx` to the kind of write it performed.
   * For `'typed'`, `'paste'`, and `'preexisting'` entries, at least one
   * position in `provenance` will equal that `globalIdx`.
   *
   * For `'external_change'` entries: when the payload carries `new_content`
   * (recorder v1.3+), every character in the reseeded content is attributed
   * to that globalIdx — so `provenance` positions DO reference it. When the
   * payload lacks `new_content` (pre-v1.3 bundle, or a >4 KB file with only
   * head/tail), the entry is a sentinel and no provenance position
   * references it. Do not assume bijection in either direction when building
   * gutter/hover decoration logic.
   */
  kindByGlobalIdx: Map<number, ProvenanceKind>;
  /** Maps `${sessionId}:${seq}` to the sha256 recorded at that save event. */
  hashBySaveSeq: Map<string, string>;
};

// ---------------------------------------------------------------------------
// Incremental line-index model (perf: O(1) position→offset)
// ---------------------------------------------------------------------------
//
// `lineStarts[k]` is the flat offset where line `k` begins. `lineStarts[0]` is
// always 0 and `lineStarts.length === (number of '\n' in content) + 1`. We
// maintain it incrementally across edits (never re-scanning the whole content)
// so converting a (line, character) position to a flat offset is O(1). This is
// the lever-1 fix for the O(n²) reconstruction: the old `positionToOffset`
// called `content.split('\n')` on every lookup.

/** Build the line-start index for a content string from scratch (O(content)). */
function computeLineStarts(content: string): number[] {
  const starts = [0];
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10 /* '\n' */) starts.push(i + 1);
  }
  return starts;
}

/** First index `i` in the ascending array `arr` with `arr[i] > value`. */
function firstIndexAbove(arr: number[], value: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid]! > value) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * Update `lineStarts` in place to reflect a splice that removed content
 * `[start, end)` and inserted `inserted` at offset `start`. Mirrors the byte
 * edit applied to the content string without scanning it.
 *
 * Line starts in `(start, end]` correspond to '\n's removed from `[start, end)`
 * and are dropped; entries strictly past the edit shift by the length delta;
 * newlines inside `inserted` add fresh entries.
 */
function updateLineStarts(
  lineStarts: number[],
  start: number,
  end: number,
  inserted: string,
): void {
  const lenDiff = inserted.length - (end - start);
  const lo = firstIndexAbove(lineStarts, start);
  const hi = firstIndexAbove(lineStarts, end);
  if (lenDiff !== 0) {
    for (let i = hi; i < lineStarts.length; i++) lineStarts[i] = lineStarts[i]! + lenDiff;
  }
  const newStarts: number[] = [];
  for (let i = 0; i < inserted.length; i++) {
    if (inserted.charCodeAt(i) === 10) newStarts.push(start + i + 1);
  }
  lineStarts.splice(lo, hi - lo, ...newStarts);
}

/**
 * Convert a line/character position to a flat string offset against a
 * maintained `lineStarts` index. Clamps character to the line length and the
 * result to the content length — byte-identical to the old `split('\n')`-based
 * `positionToOffset`, but O(1).
 */
function offsetAt(content: string, lineStarts: number[], line: number, character: number): number {
  if (line < 0) return 0;
  if (line >= lineStarts.length) return content.length;
  const lineStart = lineStarts[line]!;
  const lineEnd = line + 1 < lineStarts.length ? lineStarts[line + 1]! - 1 : content.length;
  const offset = lineStart + Math.min(character, lineEnd - lineStart);
  return Math.min(offset, content.length);
}

// ---------------------------------------------------------------------------
// Mutable replay buffer (content + per-char provenance + line index)
// ---------------------------------------------------------------------------

/**
 * The running state threaded through one reconstruction. `prov` is kept as a
 * `number[]` and mutated in place (frozen to a `Uint32Array` at the very end);
 * `lineStarts` is maintained incrementally. Invariant:
 * `content.length === prov.length`.
 */
type ReplayBuf = {
  content: string;
  prov: number[];
  lineStarts: number[];
};

/**
 * Splice `[start, end)` → `replacement` in `buf`, attributing every inserted
 * character to `globalIdx`. Mutates `content`, `prov`, and `lineStarts` in
 * place. This is the in-place analogue of `spliceWithProvenance` (which stays
 * pure for its unit tests).
 */
function spliceBuf(
  buf: ReplayBuf,
  start: number,
  end: number,
  replacement: string,
  globalIdx: number,
): void {
  buf.content = buf.content.slice(0, start) + replacement + buf.content.slice(end);
  const del = end - start;
  if (replacement.length === 0) {
    if (del > 0) buf.prov.splice(start, del);
  } else if (del === 0 && start === buf.prov.length) {
    // Append fast-path — avoids materialising + spreading a fill array.
    for (let i = 0; i < replacement.length; i++) buf.prov.push(globalIdx);
  } else {
    const fill = new Array<number>(replacement.length).fill(globalIdx);
    buf.prov.splice(start, del, ...fill);
  }
  updateLineStarts(buf.lineStarts, start, end, replacement);
}

/**
 * Splice a region of `content` and the parallel `provenance` array,
 * attributing every newly-inserted character to `globalIdx`.
 *
 * - `start` and `end` are flat offsets into `content` (`start <= end`).
 * - Characters in `[start, end)` are removed.
 * - `replacement` is inserted at position `start`.
 * - The new provenance for inserted chars is filled with `globalIdx`.
 *
 * Returns the new content and the new provenance array. Pure.
 *
 * Exported for the splice-edge-cases tests.
 */
// Exported only for unit testing of edge cases; not part of the public Phase 12 API.
export function spliceWithProvenance(
  content: string,
  provenance: number[],
  start: number,
  end: number,
  replacement: string,
  globalIdx: number,
): { content: string; provenance: number[] } {
  const newContent = content.slice(0, start) + replacement + content.slice(end);
  const newProv = provenance.slice(0, start);
  for (let i = 0; i < replacement.length; i++) {
    newProv.push(globalIdx);
  }
  for (let i = end; i < provenance.length; i++) {
    newProv.push(provenance[i]!);
  }
  return { content: newContent, provenance: newProv };
}

// ---------------------------------------------------------------------------
// Per-event handlers
// ---------------------------------------------------------------------------

/**
 * Apply a doc.change payload's deltas to `buf`, attributing every inserted
 * character to `globalIdx`. Returns `true` if at least one delta was applied
 * (parity with the old reference-inequality check the caller used to decide
 * whether to record the event in `kindByGlobalIdx`).
 *
 * IMPORTANT: deltas are applied in array order, matching v1's behavior.
 * VS Code emits them in reverse document order so each range is valid
 * against the pre-mutation document state — see v1's `applyDocChange` for
 * the long-form contract note.
 */
function applyDocChangeBuf(buf: ReplayBuf, payload: unknown, globalIdx: number): boolean {
  if (typeof payload !== 'object' || payload === null) return false;
  const p = payload as Record<string, unknown>;
  const deltas = p['deltas'];
  if (!Array.isArray(deltas)) return false;

  let applied = false;
  for (const delta of deltas as DocChangeDelta[]) {
    const start = offsetAt(buf.content, buf.lineStarts, delta.range.start.line, delta.range.start.character);
    const end = offsetAt(buf.content, buf.lineStarts, delta.range.end.line, delta.range.end.character);
    spliceBuf(buf, start, end, delta.text, globalIdx);
    applied = true;
  }
  return applied;
}

/**
 * Apply a paste payload to `buf`. Returns `false` for large pastes that lack
 * the inline `content` field — caller clears content + provenance for parity
 * with v1's taint reset.
 */
function applyPasteBuf(buf: ReplayBuf, payload: unknown, globalIdx: number): boolean {
  if (typeof payload !== 'object' || payload === null) return false;
  const p = payload as Record<string, unknown>;

  if (typeof p['content'] !== 'string') return false;
  const rangeRaw = p['range'];
  if (typeof rangeRaw !== 'object' || rangeRaw === null) return false;
  const range = rangeRaw as Range;
  const text = p['content'] as string;

  const start = offsetAt(buf.content, buf.lineStarts, range.start.line, range.start.character);
  const end = offsetAt(buf.content, buf.lineStarts, range.end.line, range.end.character);
  spliceBuf(buf, start, end, text, globalIdx);
  return true;
}

// ---------------------------------------------------------------------------
// reconstructFileWithProvenance
// ---------------------------------------------------------------------------

/**
 * Reconstruct the content of `filePath` and the per-character provenance
 * map by replaying its events from the beginning (or up to `upToGlobalIdx`,
 * exclusive).
 *
 * Semantics match v1's `reconstructFile`:
 *  - `doc.open` — if the payload has a `content` field (recorder v1.1+),
 *                 seeds content and provenance; every seeded character is
 *                 attributed to this event's globalIdx with kind
 *                 `'preexisting'`. Pre-v1.1 payloads are ignored.
 *  - `doc.close` — ignored.
 *  - `doc.change` — splice deltas; attribute inserted chars to the event.
 *  - `paste` (inline) — splice; attribute inserted chars to the event.
 *  - `paste` (large, no inline content) — clear content + provenance.
 *  - `fs.external_change` — if the payload carries `new_content` (recorder
 *    v1.3+), reseed `content` from it and attribute every character to the
 *    event's globalIdx with kind `'external_change'`. Without `new_content`
 *    (large file or pre-v1.3 bundle), clear content + provenance and leave
 *    `kindByGlobalIdx[globalIdx] = 'external_change'` as a sentinel.
 *  - `doc.save` — record sha256 in hashBySaveSeq.
 *
 * Provenance is built as a `number[]` for cheap dynamic growth and frozen
 * into a `Uint32Array` only at the return boundary.
 */
export function reconstructFileWithProvenance(
  index: EventIndex,
  filePath: string,
  upToGlobalIdx?: number,
): FileReplayState {
  const buf: ReplayBuf = { content: '', prov: [], lineStarts: [0] };
  const kindByGlobalIdx = new Map<number, ProvenanceKind>();
  const hashBySaveSeq = new Map<string, string>();

  const fileEvents = index.byFile.get(filePath) ?? [];

  for (const e of fileEvents) {
    if (upToGlobalIdx !== undefined && e.globalIdx >= upToGlobalIdx) break;

    switch (e.kind) {
      case 'doc.open': {
        // Recorder v1.1+ includes the file's initial content in the payload.
        // Seed content and provenance; attribute every character to this event.
        //
        // Pre-v1.1 doc.open events have no content field — analyzer cannot
        // recover initial content and reconstruction starts from ''.
        //
        // If this is a re-seed (e.g., file closed and reopened with new content),
        // clear all previous kindByGlobalIdx entries to avoid stale references to
        // globalIdx values from before the reopen. These entries won't have any
        // corresponding provenance positions after the new content is seeded.
        const p = e.payload as Record<string, unknown> | null;
        if (typeof p?.['content'] === 'string') {
          const initialText = p['content'];
          buf.content = initialText;
          buf.prov = Array.from({ length: initialText.length }, () => e.globalIdx);
          buf.lineStarts = computeLineStarts(initialText);
          // Clear all stale entries from before this re-seed. Subsequent
          // reconstruction will repopulate kindByGlobalIdx with only the events
          // that actually contribute to the current file state.
          kindByGlobalIdx.clear();
          kindByGlobalIdx.set(e.globalIdx, 'preexisting');
        }
        break;
      }

      case 'doc.close':
        break;

      case 'doc.change': {
        const applied = applyDocChangeBuf(buf, e.payload, e.globalIdx);
        if (applied) {
          // Recorder v1.2 broadened the paste classifier (PRD §4.3): multi-
          // delta WorkspaceEdits and large replacement edits arrive as
          // `doc.change` events with `source: "paste_likely" |
          // "paste_confirmed"` so applyDocChange can reproduce them
          // faithfully. For provenance attribution, treat those characters as
          // paste-sourced — they did not come from the keyboard. The replay
          // gutter, hover labels, and PDF screenshots all key off this map
          // and will paint the region as a paste accordingly. Default `typed`
          // unless the payload's `source` says otherwise.
          const payload = e.payload as Record<string, unknown> | null;
          const source =
            payload !== null && typeof payload['source'] === 'string'
              ? (payload['source'] as string)
              : 'typed';
          const provenanceKind: ProvenanceKind =
            source === 'paste_likely' || source === 'paste_confirmed' ? 'paste' : 'typed';
          kindByGlobalIdx.set(e.globalIdx, provenanceKind);
        }
        break;
      }

      case 'paste': {
        const applied = applyPasteBuf(buf, e.payload, e.globalIdx);
        if (applied) {
          kindByGlobalIdx.set(e.globalIdx, 'paste');
        } else {
          // Large paste (> 4 KB, no inline content) — clear both. We do NOT
          // attribute the cleared state to the paste event in
          // kindByGlobalIdx because there are no characters to attribute.
          buf.content = '';
          buf.prov = [];
          buf.lineStarts = [0];
        }
        break;
      }

      case 'fs.external_change': {
        // PRD §4.5. The payload carries an optional `operation` field
        // ('modify' | 'delete' | 'create', default 'modify' when absent).
        //
        // For 'delete' or a missing-content modify (large file / pre-v1.3
        // bundle): clear content + provenance and leave the
        // kindByGlobalIdx entry as a sentinel.
        //
        // For 'create' or any 'modify' that arrives with new_content:
        // reseed content from new_content. To keep replay readable, only
        // attribute the *changed* lines to this event — preserve the
        // existing provenance for any line that survived unchanged. Uses
        // jsdiff's diffLines so unchanged regions in the middle of an
        // otherwise-rewritten file keep their original author attribution
        // (typed / paste / preexisting), and the gutter paints only the
        // lines the external tool actually touched.
        const p = e.payload as Record<string, unknown> | null;
        const operation =
          typeof p?.['operation'] === 'string' ? (p['operation'] as string) : 'modify';
        const newContent = typeof p?.['new_content'] === 'string' ? p['new_content'] : null;
        kindByGlobalIdx.set(e.globalIdx, 'external_change');

        if (operation === 'delete' || newContent === null) {
          buf.content = '';
          buf.prov = [];
          buf.lineStarts = [0];
          break;
        }

        // 'modify' or 'create' with content available. Diff the prior
        // reconstructed state against new_content; attribute only added
        // hunks to this event, keep prior provenance for unchanged hunks.
        // (For 'create' the prior state is typically '', so diffLines
        // yields a single added hunk → whole file attributed to the
        // event, which is the right semantic.)
        const hunks = diffLines(buf.content, newContent);
        const newProv: number[] = [];
        let oldOffset = 0;
        for (const hunk of hunks) {
          const len = hunk.value.length;
          if (hunk.removed) {
            // Characters removed from the old state — skip them in old prov.
            oldOffset += len;
          } else if (hunk.added) {
            // New characters — attribute to this event.
            for (let i = 0; i < len; i++) newProv.push(e.globalIdx);
          } else {
            // Unchanged characters — copy provenance verbatim. Defensive
            // bounds guard: if `prov` is shorter than expected (shouldn't
            // happen given the invariant content.length === prov.length, but
            // cheap to handle), fall back to the event's globalIdx for any
            // tail positions.
            for (let i = 0; i < len; i++) {
              newProv.push(buf.prov[oldOffset + i] ?? e.globalIdx);
            }
            oldOffset += len;
          }
        }
        buf.content = newContent;
        buf.prov = newProv;
        buf.lineStarts = computeLineStarts(newContent);
        break;
      }

      case 'doc.save': {
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

  return {
    content: buf.content,
    provenance: Uint32Array.from(buf.prov),
    kindByGlobalIdx,
    hashBySaveSeq,
  };
}
