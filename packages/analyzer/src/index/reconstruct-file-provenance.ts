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
 * Performance: O(deltas × avg_delta_size). The `provenance` array is built
 * as a `number[]` and frozen into a `Uint32Array` at the end (option (a)
 * from the task spec) — dynamic growth on a `number[]` is the cheapest path
 * given the splice-heavy mutation pattern.
 */

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
 * Unlike `'external_change'`, preexisting entries DO have characters mapped
 * to them in the provenance array.
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
   * position in `provenance` will equal that `globalIdx`. For
   * `'external_change'` entries, the event cleared the file's content; no
   * character in `provenance` will equal that `globalIdx` (the entry is a
   * sentinel). Do not assume bijection in either direction when building
   * Phase 14 gutter/hover decoration logic.
   */
  kindByGlobalIdx: Map<number, ProvenanceKind>;
  /** Maps `${sessionId}:${seq}` to the sha256 recorded at that save event. */
  hashBySaveSeq: Map<string, string>;
};

// ---------------------------------------------------------------------------
// String + provenance splice helpers (pure)
// ---------------------------------------------------------------------------

/**
 * Convert a line/character position to a flat string offset.
 * Clamps character to the actual line length.
 *
 * Identical algorithm to v1's positionToOffset — kept here to avoid
 * exporting it from v1 (we don't want v1's surface to grow because Phase 12
 * needed a helper).
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
 * Apply a doc.change payload's deltas to `(content, provenance)`, attributing
 * every inserted character to `globalIdx`.
 *
 * IMPORTANT: deltas are applied in array order, matching v1's behavior.
 * VS Code emits them in reverse document order so each range is valid
 * against the pre-mutation document state — see v1's `applyDocChange` for
 * the long-form contract note.
 */
function applyDocChangeWithProvenance(
  content: string,
  provenance: number[],
  payload: unknown,
  globalIdx: number,
): { content: string; provenance: number[] } {
  if (typeof payload !== 'object' || payload === null) return { content, provenance };
  const p = payload as Record<string, unknown>;
  const deltas = p['deltas'];
  if (!Array.isArray(deltas)) return { content, provenance };

  let curContent = content;
  let curProv = provenance;
  for (const delta of deltas as DocChangeDelta[]) {
    const start = positionToOffset(curContent, delta.range.start.line, delta.range.start.character);
    const end = positionToOffset(curContent, delta.range.end.line, delta.range.end.character);
    const next = spliceWithProvenance(curContent, curProv, start, end, delta.text, globalIdx);
    curContent = next.content;
    curProv = next.provenance;
  }
  return { content: curContent, provenance: curProv };
}

/**
 * Apply a paste payload to `(content, provenance)`. Returns `applied: false`
 * for large pastes that lack the inline `content` field — caller decides how
 * to handle (we clear content + provenance for parity with v1's taint reset).
 */
function applyPasteWithProvenance(
  content: string,
  provenance: number[],
  payload: unknown,
  globalIdx: number,
): { content: string; provenance: number[]; applied: boolean } {
  if (typeof payload !== 'object' || payload === null) {
    return { content, provenance, applied: false };
  }
  const p = payload as Record<string, unknown>;

  if (typeof p['content'] !== 'string') {
    return { content, provenance, applied: false };
  }
  const rangeRaw = p['range'];
  if (typeof rangeRaw !== 'object' || rangeRaw === null) {
    return { content, provenance, applied: false };
  }
  const range = rangeRaw as Range;
  const text = p['content'] as string;

  const start = positionToOffset(content, range.start.line, range.start.character);
  const end = positionToOffset(content, range.end.line, range.end.character);
  const next = spliceWithProvenance(content, provenance, start, end, text, globalIdx);
  return { content: next.content, provenance: next.provenance, applied: true };
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
 *  - `fs.external_change` — clear content + provenance (the payload only
 *    carries `old_hash`/`new_hash`/`diff_size`, never the new full content,
 *    so we cannot attribute the post-change state to anything meaningful).
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
  let content = '';
  let provenance: number[] = [];
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
        const p = e.payload as Record<string, unknown> | null;
        if (typeof p?.['content'] === 'string') {
          const initialText = p['content'];
          content = initialText;
          provenance = Array.from({ length: initialText.length }, () => e.globalIdx);
          kindByGlobalIdx.set(e.globalIdx, 'preexisting');
        }
        break;
      }

      case 'doc.close':
        break;

      case 'doc.change': {
        const next = applyDocChangeWithProvenance(content, provenance, e.payload, e.globalIdx);
        if (next.content !== content || next.provenance !== provenance) {
          kindByGlobalIdx.set(e.globalIdx, 'typed');
        }
        content = next.content;
        provenance = next.provenance;
        break;
      }

      case 'paste': {
        const next = applyPasteWithProvenance(content, provenance, e.payload, e.globalIdx);
        if (next.applied) {
          kindByGlobalIdx.set(e.globalIdx, 'paste');
          content = next.content;
          provenance = next.provenance;
        } else {
          // Large paste (> 4 KB, no inline content) — clear both. We do NOT
          // attribute the cleared state to the paste event in
          // kindByGlobalIdx because there are no characters to attribute.
          content = '';
          provenance = [];
        }
        break;
      }

      case 'fs.external_change': {
        // PRD §4.5: the payload only carries hashes + diff_size, never the
        // post-change content. Clear both for parity with v1's taint reset.
        // Phase 16's `mass-external-replacement` heuristic needs to know the
        // old content was discarded; the empty state encodes that.
        content = '';
        provenance = [];
        kindByGlobalIdx.set(e.globalIdx, 'external_change');
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
    content,
    provenance: Uint32Array.from(provenance),
    kindByGlobalIdx,
    hashBySaveSeq,
  };
}
