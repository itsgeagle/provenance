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
 *   provenance variant needs to track a parallel per-character attribution
 *   alongside the content; threading that through a shared splice would force
 *   every caller (including v1's) through the same shape. Instead we re-implement
 *   the same algorithm here and add a property-based test that runs both
 *   functions on synthetic streams and asserts byte-identical `content` +
 *   identical `hashBySaveSeq`. The two paths thus stay in lockstep via tests
 *   rather than via code sharing.
 *
 * Performance: content is stored as a line-cell array (each cell is one line
 * including its trailing '\n'), with a parallel per-cell provenance array so
 * `provCells[k].length === cells[k].length`. An intra-line edit then rewrites a
 * single cell — O(line length), with no array shift — instead of rebuilding the
 * whole content string and the whole provenance array (O(content) per edit,
 * which made interior-edit reconstruction O(L²); see `docs/ingest-complexity.md`
 * "Known worst case"). The flat `provenance` Uint32Array is materialized only at
 * the return boundary. v1's `reconstruct-file.ts` mirrors this model (kept in
 * lockstep via `reconstruct-line-index.fuzz.test.ts`).
 */

import { diffLines } from 'diff';
import type { DocChangeDelta, Range } from '@provenance/log-core';
import { sha256Hex } from '@provenance/log-core';
import {
  isSuppressedExternalChange,
  collectOverCapPasteHashes,
  rememberBlob,
  resolveOverCapPaste,
} from './reconstruct-file.js';
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
 * (a file over the recorder's inline cap), the entry is a sentinel — no provenance
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
   * payload lacks `new_content` (a file over the recorder's inline cap, with only
   * head/tail), the entry is a sentinel and no provenance position
   * references it. Do not assume bijection in either direction when building
   * gutter/hover decoration logic.
   */
  kindByGlobalIdx: Map<number, ProvenanceKind>;
  /** Maps `${sessionId}:${seq}` to the sha256 recorded at that save event. */
  hashBySaveSeq: Map<string, string>;
};

/**
 * Optional observational hook for a replay pass.
 *
 * `snapshotAt` lists globalIdx values (order irrelevant — sorted internally,
 * duplicates preserved). For each value `v`, `onSnapshot(v, state)` fires with
 * `state` reflecting every event of this file whose globalIdx is < v — i.e. the
 * state *before* the event at `v`. Values past the file's last event fire after
 * the loop with the final state, so a caller can ask "what did file G look like
 * at the moment something happened in file F" without G having any event there.
 *
 * The observer never influences reconstruction: passing one produces identical
 * `content` / `provenance` / `kindByGlobalIdx` output to omitting it. The only
 * difference is that the full-stream memo cache is bypassed, because a cache hit
 * would skip the loop and fire no snapshots.
 *
 * The `state` handed to `onSnapshot` is freshly materialized per call and owned
 * by the callback; the replay does not retain or mutate it afterwards.
 */
export type ReplayObserver = {
  snapshotAt: number[];
  onSnapshot(globalIdx: number, state: FileReplayState): void;
};

// ---------------------------------------------------------------------------
// Line-cell content model (perf: O(line) intra-line edits, no lineStarts)
// ---------------------------------------------------------------------------
//
// Content is `cells: string[]` — split AFTER each '\n', so each cell carries its
// own trailing newline (the last cell may lack one). `content === cells.join('')`
// and the number of cells equals the line count, so a (line, character) position
// maps directly to (cell index, char-in-cell). `provCells` is the parallel
// per-character attribution: `provCells[k].length === cells[k].length`, which
// keeps the `content.length === provenance.length` invariant with no separate
// newline bookkeeping. See `reconstruct-file.ts` for the long-form rationale.

/** Split `content` into cells AFTER each '\n', carrying parallel provenance. */
function splitCellsWithProv(
  content: string,
  prov: number[],
): { cells: string[]; provCells: number[][] } {
  const cells: string[] = [];
  const provCells: number[][] = [];
  let start = 0;
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10 /* '\n' */) {
      cells.push(content.slice(start, i + 1));
      provCells.push(prov.slice(start, i + 1));
      start = i + 1;
    }
  }
  cells.push(content.slice(start)); // final remainder (may be '')
  provCells.push(prov.slice(start));
  return { cells, provCells };
}

/** Flatten `provCells` into the flat `Uint32Array` the return type exposes. */
function joinProvenance(provCells: number[][]): Uint32Array {
  let total = 0;
  for (const pc of provCells) total += pc.length;
  const out = new Uint32Array(total);
  let off = 0;
  for (const pc of provCells) {
    out.set(pc, off);
    off += pc.length;
  }
  return out;
}

/** Flatten `provCells` to a plain `number[]` (used by the external-change diff). */
function flattenProv(provCells: number[][]): number[] {
  const out: number[] = [];
  for (const pc of provCells) for (const v of pc) out.push(v);
  return out;
}

/** Running content + parallel per-char provenance threaded through one replay. */
type ReplayBuf = { cells: string[]; provCells: number[][] };

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
 * attributing every inserted character to `globalIdx`. Mutates `cells` and
 * `provCells` in place, preserving `provCells[k].length === cells[k].length`.
 */
function spliceBuf(
  buf: ReplayBuf,
  start: CellPos,
  end: CellPos,
  replacement: string,
  globalIdx: number,
): void {
  const isTail = end.cell === buf.cells.length - 1;
  const combinedStr =
    buf.cells[start.cell]!.slice(0, start.char) +
    replacement +
    buf.cells[end.cell]!.slice(end.char);
  // Build the parallel provenance for the merged fragment: prefix attribution,
  // then `globalIdx` for each inserted char, then suffix attribution.
  const combinedProv = buf.provCells[start.cell]!.slice(0, start.char);
  for (let i = 0; i < replacement.length; i++) combinedProv.push(globalIdx);
  const suffixProv = buf.provCells[end.cell]!;
  for (let i = end.char; i < suffixProv.length; i++) combinedProv.push(suffixProv[i]!);

  const split = splitCellsWithProv(combinedStr, combinedProv);
  // Drop the spurious trailing '' cell when the splice did not reach the tail
  // (the real continuation is the untouched cell after `end.cell`).
  if (!isTail && split.cells.length > 1 && split.cells[split.cells.length - 1] === '') {
    split.cells.pop();
    split.provCells.pop();
  }
  const removeCount = end.cell - start.cell + 1;
  buf.cells.splice(start.cell, removeCount, ...split.cells);
  buf.provCells.splice(start.cell, removeCount, ...split.provCells);
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
    const start = clampPos(buf.cells, delta.range.start.line, delta.range.start.character);
    const end = clampPos(buf.cells, delta.range.end.line, delta.range.end.character);
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
function applyPasteBuf(
  buf: ReplayBuf,
  payload: unknown,
  globalIdx: number,
  overrideText?: string,
): boolean {
  if (typeof payload !== 'object' || payload === null) return false;
  const p = payload as Record<string, unknown>;

  const text = overrideText ?? (typeof p['content'] === 'string' ? p['content'] : undefined);
  if (text === undefined) return false;
  const rangeRaw = p['range'];
  if (typeof rangeRaw !== 'object' || rangeRaw === null) return false;
  const range = rangeRaw as Range;

  const start = clampPos(buf.cells, range.start.line, range.start.character);
  const end = clampPos(buf.cells, range.end.line, range.end.character);
  spliceBuf(buf, start, end, text, globalIdx);
  return true;
}

// ---------------------------------------------------------------------------
// reconstructFileWithProvenance
// ---------------------------------------------------------------------------

/**
 * Per-`EventIndex` memo of full-stream (no `upToGlobalIdx`) reconstructions,
 * shared across consumers of one index (paste-is-solution, idle-then-complete's
 * final state) so the full-stream replay happens once per file. Keyed weakly on
 * the index; never holds cut-point results (bounded memory for replay seeking).
 */
const finalReplayCache = new WeakMap<EventIndex, Map<string, FileReplayState>>();

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
 * Provenance is tracked per-cell as `number[]` for cheap dynamic growth and
 * flattened into a `Uint32Array` only at the return boundary.
 */
export function reconstructFileWithProvenance(
  index: EventIndex,
  filePath: string,
  upToGlobalIdx?: number,
  observer?: ReplayObserver,
): FileReplayState {
  // Memoize full-stream reconstructions per index (shared by paste-is-solution
  // and idle-then-complete's final state). Cut-point reconstructions are
  // detector-specific and uncached, keeping memory bounded for replay seeking.
  // All callers treat the result as read-only.
  //
  // An observed pass must skip the memo in both directions: a hit would return
  // early and fire no snapshots.
  if (upToGlobalIdx === undefined && observer === undefined) {
    const cached = finalReplayCache.get(index)?.get(filePath);
    if (cached !== undefined) return cached;
  }

  const buf: ReplayBuf = { cells: [''], provCells: [[]] };
  const kindByGlobalIdx = new Map<number, ProvenanceKind>();
  const hashBySaveSeq = new Map<string, string>();

  const fileEvents = index.byFile.get(filePath) ?? [];

  // Over-cap paste recovery, mirroring reconstruct-file.ts. Empty for almost
  // every file, and everything below is gated on it being non-empty.
  const wantedPasteHashes = collectOverCapPasteHashes(fileEvents);
  const blobByHash = new Map<string, string>();

  // Snapshot bookkeeping. Sorted ascending; `snapCursor` is the next pending
  // value. Emitting materializes the buffer, so each fire costs O(content) —
  // bounded by the caller keeping `snapshotAt` small (see internal-move.ts,
  // which requests one point per non-trivial paste and deletion site).
  const snapPoints = observer === undefined ? [] : [...observer.snapshotAt].sort((a, b) => a - b);
  let snapCursor = 0;

  function emitSnapshotsUpTo(limit: number): void {
    while (snapCursor < snapPoints.length && snapPoints[snapCursor]! <= limit) {
      const at = snapPoints[snapCursor]!;
      snapCursor++;
      observer!.onSnapshot(at, {
        content: buf.cells.join(''),
        provenance: joinProvenance(buf.provCells),
        kindByGlobalIdx,
        hashBySaveSeq,
      });
    }
  }

  for (let i = 0; i < fileEvents.length; i++) {
    const e = fileEvents[i]!;
    // Pre-event: everything with globalIdx < e.globalIdx has been applied.
    if (observer !== undefined) emitSnapshotsUpTo(e.globalIdx);
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
          // Ground truth read from disk, and often the only surviving preimage
          // of an over-cap paste (the doc.open cap has always been 64 KB, while
          // the paste cap was 4 KB through recorder 1.1.x).
          if (wantedPasteHashes.size > 0) {
            rememberBlob(blobByHash, wantedPasteHashes, sha256Hex(initialText), initialText);
          }
          const seedProv = new Array<number>(initialText.length).fill(e.globalIdx);
          const seeded = splitCellsWithProv(initialText, seedProv);
          buf.cells = seeded.cells;
          buf.provCells = seeded.provCells;
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
        let applied = applyPasteBuf(buf, e.payload, e.globalIdx);
        if (!applied && wantedPasteHashes.size > 0) {
          // Over the recorder's inline cap, but the recorded sha256 may still
          // identify text we have already reconstructed. Shares the resolver
          // with the base replay so the two agree (pinned in lockstep by
          // reconstruct-line-index.fuzz.test.ts).
          const recovered = resolveOverCapPaste(e.payload, blobByHash);
          if (recovered !== null && applyPasteBuf(buf, e.payload, e.globalIdx, recovered)) {
            applied = true;
          }
        }
        if (applied) {
          // Recovered characters were genuinely pasted, so they are attributed
          // to the paste event exactly as an inline paste would be.
          kindByGlobalIdx.set(e.globalIdx, 'paste');
        } else {
          // Large paste over the recorder's inline cap that we could not
          // recover: we can't know what landed, so keep the surrounding content
          // and provenance rather than discarding them ('' is never the true
          // content). Not attributed in kindByGlobalIdx — there are no
          // characters to attribute.
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
        // D1/D1b/D1c: the recorder reporting the editor's own save. Not a real
        // event. Kept out of kindByGlobalIdx entirely so the replay gutter does
        // not paint phantom "external tool wrote this" regions. Shares the
        // single discriminator in reconstruct-file.ts -- the two replays must
        // agree (pinned by reconstruct-line-index.fuzz.test.ts).
        if (isSuppressedExternalChange(index, fileEvents, i)) break;

        const p = e.payload as Record<string, unknown> | null;
        const operation =
          typeof p?.['operation'] === 'string' ? (p['operation'] as string) : 'modify';
        const newContent = typeof p?.['new_content'] === 'string' ? p['new_content'] : null;
        kindByGlobalIdx.set(e.globalIdx, 'external_change');

        if (operation === 'delete') {
          // The file genuinely is gone; empty is correct.
          buf.cells = [''];
          buf.provCells = [[]];
          break;
        }
        if (newContent === null) {
          // A real external write whose content we cannot see (over the inline cap, so no
          // inline new_content). Keep the last known content and provenance
          // rather than zeroing: '' is never the true content, and the base
          // replay in reconstruct-file.ts applies the same policy (the two are
          // pinned in lockstep by reconstruct-line-index.fuzz.test.ts).
          break;
        }

        // 'modify' or 'create' with content available. Diff the prior
        // reconstructed state against new_content; attribute only added
        // hunks to this event, keep prior provenance for unchanged hunks.
        // (For 'create' the prior state is typically '', so diffLines
        // yields a single added hunk → whole file attributed to the
        // event, which is the right semantic.)
        const oldContent = buf.cells.join('');
        const oldProv = flattenProv(buf.provCells);
        const hunks = diffLines(oldContent, newContent);
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
            // bounds guard: if `oldProv` is shorter than expected (shouldn't
            // happen given the invariant content.length === prov.length, but
            // cheap to handle), fall back to the event's globalIdx for any
            // tail positions.
            for (let i = 0; i < len; i++) {
              newProv.push(oldProv[oldOffset + i] ?? e.globalIdx);
            }
            oldOffset += len;
          }
        }
        const seeded = splitCellsWithProv(newContent, newProv);
        buf.cells = seeded.cells;
        buf.provCells = seeded.provCells;
        break;
      }

      case 'doc.save': {
        const p = e.payload as Record<string, unknown> | null;
        const sha256 = typeof p?.['sha256'] === 'string' ? p['sha256'] : '';
        hashBySaveSeq.set(`${e.sessionId}:${e.seq}`, sha256);
        if (wantedPasteHashes.has(sha256) && !blobByHash.has(sha256)) {
          rememberBlob(blobByHash, wantedPasteHashes, sha256, buf.cells.join(''));
        }
        break;
      }

      default:
        // selection.change, focus.change, etc. — not relevant to content.
        break;
    }
  }

  // Snapshot points past this file's last event get the final state.
  if (observer !== undefined) emitSnapshotsUpTo(Number.MAX_SAFE_INTEGER);

  const result: FileReplayState = {
    content: buf.cells.join(''),
    provenance: joinProvenance(buf.provCells),
    kindByGlobalIdx,
    hashBySaveSeq,
  };
  if (upToGlobalIdx === undefined && observer === undefined) {
    let perIndex = finalReplayCache.get(index);
    if (perIndex === undefined) {
      perIndex = new Map();
      finalReplayCache.set(index, perIndex);
    }
    perIndex.set(filePath, result);
  }
  return result;
}
