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

import { sha256Hex } from '@provenance/log-core';
import type { DocChangeDelta, Range } from '@provenance/log-core';
import type { EventIndex, IndexedEvent } from './event-index.js';

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// A note on "the recorder's inline cap"
//
// Comments across analysis-core refer to the cap rather than a fixed number on
// purpose: it is RECORDER-VERSION-DEPENDENT, and a real corpus spans versions.
// Through VS Code recorder 1.1.x it was 4 KB for both paste content and
// fs.external_change content; later builds raise it to 64 KB (matching the
// doc.open limit). analysis-core never hardcodes either value — every consumer
// branches on whether the inline content field is PRESENT, so both generations
// of bundle are handled by the same code path. Do not reintroduce a literal
// threshold here; it would silently mis-describe half the corpus.
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
 * encountered; after a taint event (fs.external_change or a large paste over the recorder's
 * inline cap with no inline content), `content` is reset to `''` and should not be
 * treated as the true file content.
 *
 * `hashBySaveSeq` is always populated regardless of taint; the sha256 values
 * come directly from doc.save events and are not derived from `content`.
 *
 * `tainted` and `taintReasons` expose which events caused reconstruction to
 * become unreliable, for downstream consumers (Phase 4 heuristics, Phase 12
 * replay).
 *
 * Taint is RECOVERABLE: a later `doc.open` that carries inlined content is
 * ground truth read straight from disk, so it re-anchors the replay and clears
 * `tainted`. `taintReasons` is never cleared — the gap still happened and must
 * stay visible; only the "discard everything after it" behaviour is gone.
 * (Taint was permanent before 2026-07; combined with the recorder's false
 * external-change events that silently emptied ~67% of a term's
 * reconstructions. See `.notes/reconstruction-triage.md`.)
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
  /**
   * globalIdx of each `fs.external_change` that was reclassified as the
   * recorder reacting to the editor's own save, and therefore NOT applied.
   *
   * These are surfaced rather than silently dropped: an external change is the
   * highest-signal integrity event the system produces, so staff must be able
   * to see which ones were suppressed and why. See `isSelfInflictedSave`.
   */
  suppressedExternalChanges: number[];
  /**
   * globalIdx of each over-cap `paste` whose text was recovered from an earlier
   * reconstructed state via its recorded sha256. See `resolveOverCapPaste`.
   *
   * These events still appear in `taintReasons` — the recorder did drop the
   * bytes, and staff must be able to see where. They just no longer set
   * `tainted`, because the recovered text is verified against the recorded
   * hash rather than guessed.
   */
  recoveredPastes: number[];
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
  // Pastes over the recorder's inline cap record only head/tail/length/sha256.
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
 *
 * `overrideText` supplies the pasted text for an over-cap paste whose bytes were
 * recovered out of band (see `resolveOverCapPaste`); the payload's range is still
 * what decides where it lands.
 */
function applyPasteBuf(buf: ContentBuf, payload: unknown, overrideText?: string): boolean {
  if (typeof payload !== 'object' || payload === null) return false;
  const p = payload as Record<string, unknown>;
  const text = overrideText ?? (typeof p['content'] === 'string' ? p['content'] : undefined);
  if (text === undefined) return false;
  const rangeRaw = p['range'];
  if (typeof rangeRaw !== 'object' || rangeRaw === null) return false;
  const range = rangeRaw as Range;
  const start = clampPos(buf.cells, range.start.line, range.start.character);
  const end = clampPos(buf.cells, range.end.line, range.end.character);
  spliceCells(buf, start, end, text);
  return true;
}

// ---------------------------------------------------------------------------
// Over-cap paste recovery
// ---------------------------------------------------------------------------
//
// `paste.sha256` is the hash of the PASTED TEXT (recorder
// `events/paste-payload.ts`), not of the resulting document. When the text was
// over the recorder's inline cap only head/tail survive, so the paste cannot be
// applied and the file drifts until the next `doc.open` re-anchors it. For a
// paste late in a session that is the whole rest of the session.
//
// But a student who selects-all and pastes back a blob they already had is
// pasting text the replay has ALREADY reproduced byte-for-byte, and the recorded
// sha256 identifies it exactly. So it is recoverable without guessing — the hash
// arbitrates, the same way the signed manifest hash arbitrates elsewhere.
//
// Deliberately NOT extended to `fs.external_change.new_hash`. That hash
// describes the file ON DISK, which routinely differs from the in-memory
// document; reseeding the buffer from a disk state we happened to hold earlier
// rewinds it to stale content. Measured on submission 418831297: applying this
// lookup to external changes as well drove save-checkpoint agreement from 80.1%
// down to 1.5% and broke the manifest match. Keep it to pastes.

/**
 * The sha256 of every paste in this file's stream that cannot be applied from
 * its own payload. Empty for the overwhelming majority of files, which is what
 * makes the blob bookkeeping below free in the common case.
 */
export function collectOverCapPasteHashes(fileEvents: ReadonlyArray<IndexedEvent>): Set<string> {
  const wanted = new Set<string>();
  for (const e of fileEvents) {
    if (e.kind !== 'paste') continue;
    const p = e.payload as Record<string, unknown> | null;
    if (typeof p?.['content'] === 'string') continue; // inline — replayable as-is
    const hash = p?.['sha256'];
    if (typeof hash === 'string' && hash.length > 0) wanted.add(hash);
  }
  return wanted;
}

/**
 * Remember `content` as the preimage of `hash`, but only if it actually hashes
 * to it.
 *
 * The verification is the whole point: a `doc.save`'s recorded sha256 describes
 * what the recorder wrote to disk, and our buffer occasionally disagrees with it
 * (the recorder's save hash can lag the document by an edit). Storing an
 * unverified snapshot would hand a later paste the wrong bytes silently.
 */
export function rememberBlob(
  store: Map<string, string>,
  wanted: ReadonlySet<string>,
  hash: unknown,
  content: string,
): void {
  if (typeof hash !== 'string' || !wanted.has(hash) || store.has(hash)) return;
  if (sha256Hex(content) !== hash) return;
  store.set(hash, content);
}

/**
 * The text of an over-cap paste, if a previously reconstructed state proves it.
 *
 * `store` only ever holds sha256-verified blobs, so the hash match alone is
 * sound. The recorded head/tail and byte length are checked on top of it as
 * independent cross-checks — cheap, and they make a mis-keyed store entry fail
 * loudly (as a non-recovery) instead of substituting wrong content.
 */
export function resolveOverCapPaste(payload: unknown, store: Map<string, string>): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;
  const hash = p['sha256'];
  if (typeof hash !== 'string') return null;
  const candidate = store.get(hash);
  if (candidate === undefined) return null;

  const head = p['content_head'];
  if (typeof head === 'string' && !candidate.startsWith(head)) return null;
  const tail = p['content_tail'];
  if (typeof tail === 'string' && !candidate.endsWith(tail)) return null;
  // `length` is UTF-8 bytes (recorder uses Buffer.byteLength); TextEncoder is
  // the isomorphic equivalent — no node:buffer import, per the analysis-core
  // import boundary.
  const length = p['length'];
  if (typeof length === 'number' && new TextEncoder().encode(candidate).length !== length) {
    return null;
  }
  return candidate;
}

// ---------------------------------------------------------------------------
// Self-inflicted external-change detection (D1)
// ---------------------------------------------------------------------------

/**
 * Maximum wall-clock gap between an `fs.external_change` and the `doc.save`
 * that identifies it as the recorder reacting to the editor's own write.
 *
 * The two events are emitted from the same handler continuation, so in real
 * bundles the gap is 0 ms. The window exists only to absorb clock granularity.
 *
 * Keep it TIGHT. It is what bounds the false-negative risk: if an external tool
 * wrote content X and the student then saved identical content, a wide window
 * would suppress a genuine external write. A human cannot save within a second
 * of a tool's write, so 1 s separates the two cases. Widening this trades away
 * detection of real external edits — do not raise it without discussion.
 */
const SELF_INFLICTED_WINDOW_MS = 1000;

/**
 * True when `events[i]` is an `fs.external_change` that describes the editor's
 * own save rather than a third-party write.
 *
 * Recorders at VS Code <= 1.1.x and JetBrains compare a disk snapshot taken at
 * save time against a live, mutating expected-content model. A keystroke landing
 * inside that async window makes the two disagree, so the recorder reports its
 * own save as an external modification.
 *
 * The defect has two emit sites, which leave opposite signatures. Either one
 * being present is sufficient; see the two helpers below.
 *
 * Only `operation: 'modify'` qualifies; a create or delete is never this bug.
 *
 * See `.notes/external-change-false-positives.md`.
 */
export function isSelfInflictedSave(events: ReadonlyArray<IndexedEvent>, i: number): boolean {
  const e = events[i];
  if (e === undefined) return false;

  const p = e.payload as Record<string, unknown> | null;
  const operation = typeof p?.['operation'] === 'string' ? p['operation'] : 'modify';
  if (operation !== 'modify') return false;

  const newHash = p?.['new_hash'];
  if (typeof newHash !== 'string') return false;

  return (
    matchesFollowingSave(events, i, newHash) || matchesNearestPrecedingSave(events, i, newHash)
  );
}

/**
 * Event kinds that appear in a file's event list but cannot be evidence that
 * anything wrote the file, and are therefore skipped when D1 looks for "the
 * next event".
 *
 * `byFile` is keyed off any payload carrying a `path`, so it interleaves cursor
 * moves with content events — in a real bundle `selection.change` outnumbers
 * `doc.save` several to one. A caret move landing between the bogus
 * `fs.external_change` and the `doc.save` emitted from the same continuation
 * used to defeat the rule outright.
 *
 * Deliberately narrow: only kinds that provably cannot change file content
 * belong here. Anything that can (`doc.change`, `paste`) must continue to break
 * the match, because it means the following save is a *different* save than the
 * one the bogus event rode in with — which is exactly what D1's
 * same-continuation timing argument rests on.
 */
const NON_CONTENT_FILE_EVENT_KINDS = new Set<string>(['selection.change']);

/** The next event for this file that could have changed its content. */
function nextContentEvent(
  events: ReadonlyArray<IndexedEvent>,
  i: number,
): IndexedEvent | undefined {
  for (let j = i + 1; j < events.length; j++) {
    const candidate = events[j]!;
    if (!NON_CONTENT_FILE_EVENT_KINDS.has(candidate.kind)) return candidate;
  }
  return undefined;
}

/**
 * D1 — the save-path signature.
 *
 * The recorder's `onDidSaveTextDocument` handler reads disk asynchronously and
 * compares against a model that a keystroke has already advanced, then emits
 * both the bogus change and the real `doc.save` from the same continuation. So:
 *
 *   - the next CONTENT event for this file is a `doc.save`,
 *   - in the same session,
 *   - whose `sha256` equals this event's `new_hash` — i.e. the "external"
 *     content is byte-identical to what the editor itself wrote, and
 *   - within `SELF_INFLICTED_WINDOW_MS`.
 *
 * Validated against a 156-bundle corpus: matched 3316 of 3316 of the false
 * positives it targets, with zero genuine external changes reclassified.
 */
function matchesFollowingSave(
  events: ReadonlyArray<IndexedEvent>,
  i: number,
  newHash: string,
): boolean {
  const e = events[i]!;
  const next = nextContentEvent(events, i);
  if (next === undefined) return false;
  if (next.kind !== 'doc.save') return false;
  if (next.sessionId !== e.sessionId) return false;

  const savedHash = (next.payload as Record<string, unknown> | null)?.['sha256'];
  if (newHash !== savedHash) return false;

  const dt = Math.abs(Date.parse(next.wall) - Date.parse(e.wall));
  return Number.isFinite(dt) && dt <= SELF_INFLICTED_WINDOW_MS;
}

/**
 * D1b — the fs-watcher-path signature (the mirror image of D1).
 *
 * `fs-watcher.ts` `handleChange` fires for the editor's own write, reads disk
 * asynchronously, and by the time the read resolves the student has typed on.
 * The event therefore reports `old_hash` = the live buffer and `new_hash` = the
 * state the editor last *saved*. The matching `doc.save` PRECEDES the event, so
 * `matchesFollowingSave` never fires — and these events were consequently
 * misfiled as genuine external writes.
 *
 * Discriminator: `new_hash` equals the `sha256` of the NEAREST preceding
 * `doc.save` for this file in this session.
 *
 * There is deliberately no time window here, unlike D1. The two rules bound
 * their false-negative risk in different ways:
 *
 *   - D1 is a TIMING argument ("emitted from the same continuation"), so it
 *     needs a tight window — a tool could write content that the student later
 *     saves identically, and only the clock separates those cases.
 *   - D1b is a CONTENT-IDENTITY argument. It fires only when disk held exactly
 *     the bytes the editor itself last wrote, with no intervening save. At that
 *     instant no foreign content is present on disk by construction, so there
 *     is nothing for a window to protect. Elapsed time does not change that.
 *
 * "Nearest" is load-bearing. Matching against any earlier save would forgive a
 * disk that had been rewound past the latest save — which is a real external
 * write, and one worth seeing.
 *
 * A tool that writes foreign content and then restores the last saved bytes
 * still surfaces: the first write produces content no save ever held, so it is
 * reported; only the restore is forgiven.
 *
 * Measured on a term-1 bundle recorded by an affected build: matched 213/213 of
 * the surviving false positives, and reconstruction then reproduced the
 * submitted file byte-for-byte.
 */
function matchesNearestPrecedingSave(
  events: ReadonlyArray<IndexedEvent>,
  i: number,
  newHash: string,
): boolean {
  const e = events[i]!;
  // Walk back to the most recent doc.save for this file in this session. The
  // scan stops at the first save (or the session boundary), so it stays short
  // in practice — students save far more often than tools write.
  for (let j = i - 1; j >= 0; j--) {
    const prev = events[j]!;
    if (prev.sessionId !== e.sessionId) return false;
    if (prev.kind !== 'doc.save') continue;
    return (prev.payload as Record<string, unknown> | null)?.['sha256'] === newHash;
  }
  return false;
}

/**
 * D1c — disk content that the student's own edits account for.
 *
 * D1 and D1b are both anchored on `doc.save.sha256`. That field is produced by
 * the same asynchronous disk read the whole defect stems from, so it is itself
 * routinely stale (D1a in `.notes/external-change-false-positives.md`). When it
 * is, neither save-anchored rule can match however the window is tuned, and the
 * bogus event survives into the UI.
 *
 * This rule drops the save entirely. It replays the file from the student's own
 * editor events and asks whether `new_hash` is the content that replay produces.
 * If it is, the bytes on disk are exactly what the student typed, so nothing
 * outside the editor wrote that file — whatever the recorder's model believed at
 * the time.
 *
 * Measured on a term-1 submission: D1+D1b suppressed 167 of 189 events; this
 * rule takes it to 188, and every one of the 21 it adds was independently
 * confirmed to be a state the buffer passed through.
 *
 * Two deliberate choices, both load-bearing:
 *
 *   - **Only the CURRENT replay state counts** (the caller asked for lag 0, and
 *     the field data supports it: all 24 additions matched the state at that
 *     exact point). A window of recent states would also forgive a tool that
 *     rewound the file to something the student typed a few edits ago. Matching
 *     only the current state means the forgiven content is, at that instant,
 *     indistinguishable from the buffer — there is nothing to see.
 *
 *   - **`fs.external_change` never reseeds this replay.** The question being
 *     asked is "do the student's own events account for these bytes", so the
 *     replay must contain nothing but those events. This also means a genuine
 *     external write leaves the replay diverged from disk — which is safe in the
 *     right direction: divergence makes an exact sha256 match LESS likely, never
 *     more, so an unexplained event can never manufacture later suppressions.
 *     (Giving up on the file after the first non-match instead was measured to
 *     cost 14 of 24 suppressions on the same submission, because one transient
 *     mid-save truncation poisoned everything after it.)
 *
 * Over-cap pastes are not recovered here (`applyPasteBuf` simply fails and the
 * replay drifts). Recovery needs the blob bookkeeping `reconstructFile` does,
 * and drift is self-limiting for the same reason as above.
 */
export function findEditDerivedExternalChanges(
  fileEvents: ReadonlyArray<IndexedEvent>,
): Set<number> {
  const result = new Set<number>();
  // Most files never see an external change; skip the replay entirely for them.
  if (!fileEvents.some((e) => e.kind === 'fs.external_change')) return result;

  const buf: ContentBuf = { cells: [''] };

  for (const e of fileEvents) {
    switch (e.kind) {
      case 'doc.open': {
        const p = e.payload as Record<string, unknown> | null;
        if (typeof p?.['content'] === 'string') buf.cells = splitCells(p['content']);
        break;
      }

      case 'doc.change':
        applyDocChangeBuf(buf, e.payload);
        break;

      case 'paste':
        applyPasteBuf(buf, e.payload);
        break;

      case 'fs.external_change': {
        const p = e.payload as Record<string, unknown> | null;
        // A create or delete is never this bug — same guard as isSelfInflictedSave.
        const operation = typeof p?.['operation'] === 'string' ? p['operation'] : 'modify';
        if (operation !== 'modify') break;
        const newHash = p?.['new_hash'];
        if (typeof newHash !== 'string') break;
        if (newHash === sha256Hex(buf.cells.join(''))) result.add(e.globalIdx);
        break;
      }

      default:
        // Not content-bearing.
        break;
    }
  }

  return result;
}

/**
 * Whether the `fs.external_change` at `fileEvents[i]` is one of the recorder's
 * own saves and must not be applied or reported.
 *
 * The single entry point for both replays, so they cannot drift apart (pinned by
 * `reconstruct-line-index.fuzz.test.ts`) and so both agree with the set the
 * heuristics read off the index.
 *
 * `buildIndex` has already evaluated all three rules, so the precomputed set is
 * authoritative when present — this is also the only way D1c is available here,
 * since it needs a whole-file replay that would be quadratic to redo per event.
 * Indexes assembled by hand (tests) or by `buildIndexFromEventRows` may omit the
 * field; those fall back to the two rules that are cheap to evaluate locally.
 */
export function isSuppressedExternalChange(
  index: EventIndex,
  fileEvents: ReadonlyArray<IndexedEvent>,
  i: number,
): boolean {
  const precomputed = index.selfInflictedExternalChanges;
  if (precomputed !== undefined) return precomputed.has(fileEvents[i]!.globalIdx);
  return isSelfInflictedSave(fileEvents, i);
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
  const suppressedExternalChanges: number[] = [];
  const recoveredPastes: number[] = [];

  const fileEvents = index.byFile.get(filePath) ?? [];

  // Over-cap paste recovery. `wantedPasteHashes` is empty for almost every
  // file, and everything below is gated on it being non-empty, so files without
  // an unapplicable paste pay only this one scan.
  const wantedPasteHashes = collectOverCapPasteHashes(fileEvents);
  const blobByHash = new Map<string, string>();

  for (let i = 0; i < fileEvents.length; i++) {
    const e = fileEvents[i]!;
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
          // Ground truth read from disk. Through recorder 1.1.x the doc.open cap
          // was already 64 KB while the paste cap was 4 KB, so a doc.open is
          // frequently the only surviving preimage of an over-cap paste.
          if (wantedPasteHashes.size > 0) {
            rememberBlob(blobByHash, wantedPasteHashes, sha256Hex(p['content']), p['content']);
          }
          buf.cells = splitCells(p['content']);
          // D2: a doc.open that carries content is ground truth straight from
          // disk, so it re-anchors the replay and CLEARS any prior taint. Taint
          // used to be permanent, which turned one contentless external change
          // into a dead reconstruction for the rest of the bundle. taintReasons
          // is deliberately left intact — the gap still happened and staff must
          // still see it; we just stop discarding everything after it.
          tainted = false;
        }
        break;
      }

      case 'doc.close':
        // Ignored for content reconstruction.
        break;

      case 'doc.change':
        // Deltas keep applying even while tainted. Content is documented as
        // best-effort and `tainted` is what tells callers not to trust it;
        // dropping every later edit made the result *definitely* wrong instead
        // of *possibly* stale, and destroyed the rest of the session.
        applyDocChangeBuf(buf, e.payload);
        break;

      case 'paste': {
        if (applyPasteBuf(buf, e.payload)) break; // inline — replayable as-is

        // Over the recorder's inline cap, but the recorded sha256 may still
        // identify text we have already reconstructed.
        let recovered = false;
        if (wantedPasteHashes.size > 0) {
          const text = resolveOverCapPaste(e.payload, blobByHash);
          if (text !== null && applyPasteBuf(buf, e.payload, text)) recovered = true;
        }
        if (recovered) {
          recoveredPastes.push(e.globalIdx);
        } else {
          // We can't know what landed, so mark the reconstruction unreliable —
          // but keep the surrounding content rather than discarding it.
          tainted = true;
        }
        // Either way the recorder dropped these bytes, and that stays visible to
        // staff even when we recovered them out of band.
        taintReasons.push({ globalIdx: e.globalIdx, reason: 'large_paste' });
        break;
      }

      case 'fs.external_change': {
        // PRD §4.5. The recorder inlines the post-change content when it fits
        // under its inline cap
        // and an optional `operation` discriminator ('modify' | 'delete' |
        // 'create', default 'modify' when absent).
        //
        // 'delete' or modify-without-content (large file / pre-v1.3
        // bundle) → clear content + taint. 'modify' or 'create' with
        // content → reseed; reconstruction stays valid (no taint).
        // D1: the recorder reporting its own save. Not a real event — do not
        // taint, do not reseed, do not record a taint reason. Surfaced via
        // suppressedExternalChanges so the UI can still show what was
        // reclassified.
        if (isSuppressedExternalChange(index, fileEvents, i)) {
          suppressedExternalChanges.push(e.globalIdx);
          break;
        }

        const p = e.payload as Record<string, unknown> | null;
        const operation =
          typeof p?.['operation'] === 'string' ? (p['operation'] as string) : 'modify';
        const newContent = typeof p?.['new_content'] === 'string' ? p['new_content'] : null;
        // taintReasons stays populated regardless so consumers that want a
        // "this file had an external edit at globalIdx N" signal still see it.
        taintReasons.push({ globalIdx: e.globalIdx, reason: 'fs_external_change' });
        if (operation === 'delete') {
          // The file genuinely is gone; empty is the correct content.
          tainted = true;
          buf.cells = [''];
        } else if (newContent === null) {
          // A real external write we cannot see the content of (over the cap, so no
          // inline new_content). Mark it unreliable, but KEEP the last known
          // content: '' is never the true content, whereas stale content is
          // frequently still correct — and callers gate on `tainted`.
          //
          // Measured: across a 156-bundle corpus, 8 submissions reproduce their
          // SIGNED manifest sha256 exactly under this policy and reconstructed
          // to empty under the old zeroing policy.
          tainted = true;
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
        // A save whose recorded hash some over-cap paste is looking for: our
        // buffer is a candidate preimage. `rememberBlob` verifies before storing,
        // and the join only happens for the handful of hashes actually wanted.
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

  const result: ReconstructResult = {
    content: buf.cells.join(''),
    hashBySaveSeq,
    tainted,
    taintReasons,
    suppressedExternalChanges,
    recoveredPastes,
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
