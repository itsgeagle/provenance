/**
 * Check 7 — Per-file doc.save hash consistency.
 * PRD §5.4 step 7.
 *
 * For each doc.save event, this check attempts to verify that the saved
 * content hash is consistent with the sequence of doc.change / paste events
 * that preceded it since the previous save (or doc.open).
 *
 * Reconstruction approach:
 *
 *  - We track in-memory content per file by applying doc.change deltas to a
 *    running string. We seed the string from the doc.open event's inlined
 *    `content` field when present (recorder v1.1+ ships up to 64 KB of
 *    initial content inside the payload). When `content` is absent — pre-
 *    v1.1 bundles, files that exceeded the 64 KB inline cap and got
 *    `truncated: true`, or files that never received a doc.open — we cannot
 *    reconstruct from scratch and mark the file as indeterminate until the
 *    next anchor.
 *  - For paste events with inline content (content field present), we apply
 *    the paste to the current tracked state by inserting the content at the
 *    target range.
 *  - A paste event with no inline content (large paste > 4 KB, only head/tail
 *    + sha256 recorded) makes reconstruction impossible. In that case we mark
 *    subsequent saves up to the next recoverable point as 'indeterminate' and
 *    emit a pass with an explanation.
 *  - After applying each delta we SHA-256 the resulting string and compare to
 *    doc.save.sha256. Mismatch is a failure UNLESS a fs.external_change event
 *    for the same file appears between the previous save and this one (the
 *    recorder already accounted for the divergence).
 *
 * Note: this check predates the Phase-3 `reconstructFile` indexer
 * (`src/index/reconstruct-file.ts`), which performs the same kind of replay
 * but with provenance tracking. The two implementations are kept in lockstep
 * by sharing the doc.open seed rule and the splice algorithm; if you change
 * one, audit the other.
 */

import { sha256Hex } from '@provenance/log-core';
import type { DocChangeDelta, Range } from '@provenance/log-core';
import type { HashedEnvelope } from '@provenance/log-core';
import type { Bundle } from '../loader/types.js';
import type { ValidationCheck } from './check-types.js';

// ---------------------------------------------------------------------------
// String content model helpers
// ---------------------------------------------------------------------------
//
// Position→offset is resolved against an incrementally-maintained line-start
// index rather than re-splitting the content on every lookup. The old
// `split('\n')`-per-call made this check O(n²) in the number of events; see
// `.notes/ingest-perf-investigation.md`. Kept in lockstep with the same model
// in `src/index/reconstruct-file.ts`.

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
 * Update `lineStarts` in place to reflect a splice that removed `[start, end)`
 * and inserted `inserted` at `start`. Mirrors the byte edit without scanning
 * the content.
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

/** O(1) line/character → flat offset against a maintained `lineStarts` index. */
function offsetAt(content: string, lineStarts: number[], line: number, character: number): number {
  if (line < 0) return 0;
  if (line >= lineStarts.length) return content.length;
  const lineStart = lineStarts[line]!;
  const lineEnd = line + 1 < lineStarts.length ? lineStarts[line + 1]! - 1 : content.length;
  const offset = lineStart + Math.min(character, lineEnd - lineStart);
  return Math.min(offset, content.length);
}

// ---------------------------------------------------------------------------
// Per-file state during a session scan
// ---------------------------------------------------------------------------

type FileState = {
  content: string;
  /** Incrementally-maintained line-start index for `content`. Invariant:
   *  `lineStarts[0] === 0` and stays consistent with `content`. */
  lineStarts: number[];
  /** True if a large paste (> 4 KB, no inline content) was seen since the
   *  last verified save. Content reconstruction is unreliable past this point. */
  indeterminate: boolean;
  /** True if a fs.external_change was seen since the last save. */
  externalChangeSinceSave: boolean;
};

/** Splice `[start, end)` → `replacement` in `state`, maintaining the line index. */
function spliceFileState(state: FileState, start: number, end: number, replacement: string): void {
  state.content = state.content.slice(0, start) + replacement + state.content.slice(end);
  updateLineStarts(state.lineStarts, start, end, replacement);
}

/** Apply a single DocChangeDelta to `state`. */
function applyDelta(state: FileState, delta: DocChangeDelta): void {
  const start = offsetAt(state.content, state.lineStarts, delta.range.start.line, delta.range.start.character);
  const end = offsetAt(state.content, state.lineStarts, delta.range.end.line, delta.range.end.character);
  spliceFileState(state, start, end, delta.text);
}

/** Apply a paste to `state` given a target Range and text. */
function applyPaste(state: FileState, range: Range, text: string): void {
  const start = offsetAt(state.content, state.lineStarts, range.start.line, range.start.character);
  const end = offsetAt(state.content, state.lineStarts, range.end.line, range.end.character);
  spliceFileState(state, start, end, text);
}

// ---------------------------------------------------------------------------
// Main check
// ---------------------------------------------------------------------------

type SaveFailure = {
  sessionId: string;
  seq: number;
  path: string;
  reason: 'hash_mismatch' | 'indeterminate';
  detail: string;
};

/**
 * Scan all events in one session for doc.save hash consistency.
 */
function checkSession(
  sessionId: string,
  events: readonly HashedEnvelope[],
): { failures: SaveFailure[]; indeterminates: SaveFailure[] } {
  const fileStates = new Map<string, FileState>();

  function getOrCreate(path: string): FileState {
    let state = fileStates.get(path);
    if (!state) {
      state = {
        content: '',
        lineStarts: [0],
        indeterminate: false,
        externalChangeSinceSave: false,
      };
      fileStates.set(path, state);
    }
    return state;
  }

  const failures: SaveFailure[] = [];
  const indeterminates: SaveFailure[] = [];

  for (const event of events) {
    switch (event.kind) {
      case 'doc.open': {
        // Recorder v1.1+ inlines the file's initial content (up to 64 KB) in
        // the doc.open payload. When present, seed the running content from
        // it so that subsequent deltas resolve against the correct baseline
        // and the first save can actually be verified. When absent — older
        // recorders, or files that hit the 64 KB inline cap and carry
        // `truncated: true` — we have no way to recover initial content and
        // mark the file as indeterminate.
        const data = event.data as { path: string; sha256: string; content?: string };
        const state = getOrCreate(data.path);
        if (typeof data.content === 'string') {
          state.content = data.content;
          state.lineStarts = computeLineStarts(data.content);
          state.indeterminate = false;
        } else {
          state.indeterminate = true;
        }
        break;
      }

      case 'doc.change': {
        const data = event.data as { path: string; deltas: DocChangeDelta[] };
        const state = getOrCreate(data.path);
        if (!state.indeterminate) {
          // Apply each delta in order.
          for (const delta of data.deltas) {
            applyDelta(state, delta);
          }
        }
        break;
      }

      case 'paste': {
        const data = event.data as {
          path: string;
          range: Range;
          content?: string;
          length: number;
          sha256: string;
        };
        const state = getOrCreate(data.path);
        if (state.indeterminate) break;

        if (data.content !== undefined) {
          // Inline paste — apply it.
          applyPaste(state, data.range, data.content);
        } else {
          // Large paste: content not available inline. Reconstruction is no
          // longer possible until the next verified anchor.
          state.indeterminate = true;
        }
        break;
      }

      case 'fs.external_change': {
        const data = event.data as { path: string };
        const state = getOrCreate(data.path);
        state.externalChangeSinceSave = true;
        // The recorder knows about this change; reconstruction is invalidated.
        state.indeterminate = true;
        break;
      }

      case 'doc.save': {
        const data = event.data as { path: string; sha256: string };
        const state = getOrCreate(data.path);

        if (state.externalChangeSinceSave) {
          // fs.external_change was seen — the mismatch is accounted for. Reset
          // the external-change flag and clear indeterminate if the hash now
          // anchors us.
          state.externalChangeSinceSave = false;
          state.content = ''; // We don't know the new content, but mark as fresh anchor
          state.lineStarts = [0];
          // We can't reconstruct from here either without knowing content.
          state.indeterminate = true;
          break;
        }

        if (state.indeterminate) {
          indeterminates.push({
            sessionId,
            seq: event.seq,
            path: data.path,
            reason: 'indeterminate',
            detail:
              `Save at seq ${event.seq} (${data.path}): reconstruction not possible — ` +
              `file was opened with unknown content or contained a large paste (>4 KB inline limit). ` +
              `Relying on doc.save sha256 alone.`,
          });
          // Can't recover content from sha256 — stay indeterminate.
          break;
        }

        // Reconstruction is possible — compare hashes.
        const computedHash = sha256Hex(state.content);
        if (computedHash !== data.sha256) {
          failures.push({
            sessionId,
            seq: event.seq,
            path: data.path,
            reason: 'hash_mismatch',
            detail:
              `Save at seq ${event.seq} (${data.path}): computed sha256 ${computedHash} ` +
              `does not match recorded sha256 ${data.sha256}.`,
          });
        }
        // Hash matched or mismatched — keep content for next interval.
        break;
      }

      default:
        break;
    }
  }

  return { failures, indeterminates };
}

// ---------------------------------------------------------------------------
// Exported check
// ---------------------------------------------------------------------------

export function verifyDocSaveHashes(bundle: Bundle): ValidationCheck {
  const allFailures: SaveFailure[] = [];
  const allIndeterminates: SaveFailure[] = [];

  for (const session of bundle.sessions) {
    const { failures, indeterminates } = checkSession(session.sessionId, session.events);
    allFailures.push(...failures);
    allIndeterminates.push(...indeterminates);
  }

  if (allFailures.length > 0) {
    const descriptions = allFailures.map((f) => f.detail).join(' | ');
    return {
      id: 'doc_save_hashes',
      label: 'Doc save hash consistency',
      status: 'fail',
      detail: `${allFailures.length} save hash mismatch(es): ${descriptions}`,
      supportingSeqs: allFailures.map((f) => ({ sessionId: f.sessionId, seq: f.seq })),
    };
  }

  if (allIndeterminates.length > 0) {
    return {
      id: 'doc_save_hashes',
      label: 'Doc save hash consistency',
      status: 'pass',
      detail:
        `${allIndeterminates.length} save(s) could not be reconstructed (file opened with unknown ` +
        `content or paste exceeded 4 KB inline limit); relying on doc.save sha256 alone for those.`,
    };
  }

  return {
    id: 'doc_save_hashes',
    label: 'Doc save hash consistency',
    status: 'pass',
  };
}
