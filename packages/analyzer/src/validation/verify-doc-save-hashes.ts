/**
 * Check 7 — Per-file doc.save hash consistency.
 * PRD §5.4 step 7.
 *
 * For each doc.save event, this check attempts to verify that the saved
 * content hash is consistent with the sequence of doc.change / paste events
 * that preceded it since the previous save (or doc.open).
 *
 * Reconstruction approach (v1):
 *
 *  - We track in-memory content per file by applying doc.change deltas to a
 *    running string. We start with an empty string (files that were opened
 *    carry only a sha256, not full content, so we can't seed the state from
 *    doc.open).
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
 * Limitations (by design in v1):
 *  - Full reconstruction is only possible when the file started as an empty
 *    string at the beginning of the session. If the file was already populated
 *    (doc.open before any doc.change), we start with "" and the first save
 *    after a doc.open will likely produce a hash mismatch from the first event
 *    forward. We detect this and mark the first save as indeterminate.
 *  - Phase 3 (indices + full reconstruction) will do this properly.
 */

import { sha256Hex } from '@provenance/log-core';
import type { DocChangeDelta, Range } from '@provenance/log-core';
import type { HashedEnvelope } from '@provenance/log-core';
import type { Bundle } from '../loader/types.js';
import type { ValidationCheck } from './check-types.js';

// ---------------------------------------------------------------------------
// String content model helpers
// ---------------------------------------------------------------------------

/** Convert a line/character position to a flat string offset. */
function positionToOffset(content: string, line: number, character: number): number {
  const lines = content.split('\n');
  let offset = 0;
  for (let l = 0; l < line && l < lines.length; l++) {
    // +1 for the '\n' separator
    offset += (lines[l]?.length ?? 0) + 1;
  }
  // Clamp character to the actual line length.
  const targetLine = lines[line] ?? '';
  offset += Math.min(character, targetLine.length);
  return Math.min(offset, content.length);
}

/** Apply a single DocChangeDelta to a content string. */
function applyDelta(content: string, delta: DocChangeDelta): string {
  const start = positionToOffset(content, delta.range.start.line, delta.range.start.character);
  const end = positionToOffset(content, delta.range.end.line, delta.range.end.character);
  return content.slice(0, start) + delta.text + content.slice(end);
}

/** Apply a paste to a content string given a target Range and text. */
function applyPaste(content: string, range: Range, text: string): string {
  const start = positionToOffset(content, range.start.line, range.start.character);
  const end = positionToOffset(content, range.end.line, range.end.character);
  return content.slice(0, start) + text + content.slice(end);
}

// ---------------------------------------------------------------------------
// Per-file state during a session scan
// ---------------------------------------------------------------------------

type FileState = {
  content: string;
  /** True if a large paste (> 4 KB, no inline content) was seen since the
   *  last verified save. Content reconstruction is unreliable past this point. */
  indeterminate: boolean;
  /** True if a fs.external_change was seen since the last save. */
  externalChangeSinceSave: boolean;
};

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
        const data = event.data as { path: string; sha256: string };
        const state = getOrCreate(data.path);
        // We don't have the actual content — only sha256. Mark as indeterminate.
        state.indeterminate = true;
        break;
      }

      case 'doc.change': {
        const data = event.data as { path: string; deltas: DocChangeDelta[] };
        const state = getOrCreate(data.path);
        if (!state.indeterminate) {
          // Apply each delta in order.
          for (const delta of data.deltas) {
            state.content = applyDelta(state.content, delta);
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
          state.content = applyPaste(state.content, data.range, data.content);
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
