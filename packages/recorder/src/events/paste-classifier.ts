/**
 * Paste classifier — signal 1 of three-signal paste detection (PRD §4.3).
 *
 * Originally (per PRD's literal wording): exactly ONE delta whose
 * text.length ≥ 30 AND whose range is empty. That catches classical Cmd+V
 * pastes but misses tool-applied edits (Claude Code, Copilot apply, etc.)
 * which routinely arrive as either multi-delta WorkspaceEdits or as
 * single deltas that REPLACE existing text rather than insert at an empty
 * range. Those slipped through as plain `doc.change` events with
 * `source: 'typed'`, defeating downstream "low typing, high output"
 * detection.
 *
 * Broadened rule (intent-preserving, schema-compatible — the
 * `'paste_likely'` `source` value is already in DocChangePayload):
 *
 *   paste_likely if ANY of:
 *     - a single delta with text.length ≥ PASTE_MIN_INSERT_CHARS
 *       (covers classical paste AND large single-shot replacement edits)
 *     - total inserted chars across deltas ≥ PASTE_MIN_INSERT_CHARS AND
 *       at least one delta's text contains a newline
 *       (covers multi-delta WorkspaceEdits that span lines — typical of
 *       AI-applied edits — without flagging multi-cursor typing, which
 *       produces many small deltas without embedded newlines)
 *   typed otherwise.
 *
 * Pure function. No I/O, no global state.
 */

import type { DocChangeDelta } from '@provenance/log-core';

export type PasteClassification = 'typed' | 'paste_likely';

/** Minimum characters for an insert to be classified as paste_likely. */
export const PASTE_MIN_INSERT_CHARS = 30;

/**
 * Given the delta set from a single doc.change event, classify whether
 * it looks like a paste / bulk insertion (vs. natural keystroke typing).
 *
 * See module header for the full rule. The classifier is intentionally
 * coarse — false positives are addressed downstream by paste reconciler
 * (signal 3) and analyzer-side heuristics, both of which have more
 * context than a single-event view.
 */
export function classifyChange(deltas: DocChangeDelta[]): PasteClassification {
  if (deltas.length === 0) return 'typed';

  let totalInsertedChars = 0;
  let maxSingleDeltaChars = 0;
  let anyDeltaHasNewline = false;

  for (const delta of deltas) {
    const len = delta.text.length;
    totalInsertedChars += len;
    if (len > maxSingleDeltaChars) maxSingleDeltaChars = len;
    if (!anyDeltaHasNewline && delta.text.indexOf('\n') !== -1) {
      anyDeltaHasNewline = true;
    }
  }

  // Rule 1: a single delta carries ≥ threshold chars on its own.
  // Covers classical paste (empty-range insert) AND large replacement
  // edits where range is non-empty.
  if (maxSingleDeltaChars >= PASTE_MIN_INSERT_CHARS) {
    return 'paste_likely';
  }

  // Rule 2: aggregate of multi-delta event ≥ threshold AND at least one
  // delta text contains a newline. The newline gate is what
  // distinguishes a multi-line bulk edit (e.g. Claude Code applying a
  // WorkspaceEdit across several lines) from multi-cursor typing
  // (many small single-line inserts at distinct cursors).
  if (totalInsertedChars >= PASTE_MIN_INSERT_CHARS && anyDeltaHasNewline) {
    return 'paste_likely';
  }

  return 'typed';
}
