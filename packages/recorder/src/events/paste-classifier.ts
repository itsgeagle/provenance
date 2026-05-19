/**
 * Paste classifier — signal 1 of three-signal paste detection (PRD §4.3).
 *
 * Rule: exactly ONE delta whose text.length >= 30 AND whose range is "empty"
 * (start === end → zero deletions). Otherwise 'typed'.
 *
 * Pure function. No I/O, no global state.
 */

import type { DocChangeDelta } from '@provenance/log-core';

export type PasteClassification = 'typed' | 'paste_likely';

/** Minimum characters for a single-insert to be classified as paste_likely. */
export const PASTE_MIN_INSERT_CHARS = 30;

/**
 * Given the delta set from a single doc.change event, classify whether
 * it looks like a paste.
 *
 * paste_likely: exactly one delta, text.length >= PASTE_MIN_INSERT_CHARS,
 *               range is empty (start == end → no deletion).
 * typed:        anything else.
 */
export function classifyChange(deltas: DocChangeDelta[]): PasteClassification {
  if (deltas.length !== 1) {
    return 'typed';
  }
  const delta = deltas[0];
  if (delta === undefined) {
    return 'typed';
  }

  const isEmptyRange =
    delta.range.start.line === delta.range.end.line &&
    delta.range.start.character === delta.range.end.character;

  if (delta.text.length >= PASTE_MIN_INSERT_CHARS && isEmptyRange) {
    return 'paste_likely';
  }

  return 'typed';
}
