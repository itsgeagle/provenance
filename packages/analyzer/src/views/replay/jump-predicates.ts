/**
 * jump-predicates.ts — pure functions for finding the next jump target in the
 * replay event stream.
 *
 * Used by JumpControls to implement:
 *   - Next paste
 *   - Next external change
 *   - Next flag (event whose globalIdx appears in any flag's supportingSeqs)
 *   - Next file switch
 *
 * All functions are pure (no side effects, no React).
 *
 * PRD ref: §7.2 (jump-to: next paste/external/flag/file-switch).
 */

import type { IndexedEvent } from '@provenance/analysis-core/index/event-index.js';
import type { Flag } from '@provenance/analysis-core/heuristics/types.js';

// ---------------------------------------------------------------------------
// findNextPaste
// ---------------------------------------------------------------------------

/**
 * True if an event is paste-shaped — either a native `paste` event OR a
 * `doc.change` whose payload `source` is `'paste_likely'` or
 * `'paste_confirmed'`. Recorder v1.2's broadened classifier routes multi-
 * delta WorkspaceEdits and large replacement edits through the latter
 * shape (PRD §4.3); the "next paste" jump should land on those too,
 * otherwise the most interesting AI-applied edits get skipped.
 */
function isPasteShaped(e: IndexedEvent): boolean {
  if (e.kind === 'paste') return true;
  if (e.kind === 'doc.change') {
    const p = e.payload as Record<string, unknown> | null;
    const source =
      p !== null && typeof p['source'] === 'string' ? (p['source'] as string) : 'typed';
    return source === 'paste_likely' || source === 'paste_confirmed';
  }
  return false;
}

/**
 * Find the globalIdx of the next paste-shaped event strictly after
 * `currentGlobalIdx`. Returns null if no such event exists.
 */
export function findNextPaste(
  events: readonly IndexedEvent[],
  currentGlobalIdx: number,
): number | null {
  for (const e of events) {
    if (e.globalIdx > currentGlobalIdx && isPasteShaped(e)) {
      return e.globalIdx;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// findNextExternalChange
// ---------------------------------------------------------------------------

/**
 * Find the globalIdx of the next `fs.external_change` event strictly after
 * `currentGlobalIdx`. Returns null if no such event exists.
 */
export function findNextExternalChange(
  events: readonly IndexedEvent[],
  currentGlobalIdx: number,
): number | null {
  for (const e of events) {
    if (e.globalIdx > currentGlobalIdx && e.kind === 'fs.external_change') {
      return e.globalIdx;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// buildFlaggedGlobalIdxSet
// ---------------------------------------------------------------------------

/**
 * Build a Set<number> of globalIdx values that appear as supporting events
 * in any flag. Used by findNextFlag.
 *
 * `${sessionId}:${seq}` keys in `flag.supportingSeqs` are resolved against
 * `index.bySeq` to get the globalIdx.
 *
 * @param flags   Array of flags from the heuristics engine.
 * @param bySeq   EventIndex.bySeq map (`${sessionId}:${seq}` → IndexedEvent).
 */
export function buildFlaggedGlobalIdxSet(
  flags: readonly Flag[],
  bySeq: ReadonlyMap<string, IndexedEvent>,
): Set<number> {
  const result = new Set<number>();
  for (const flag of flags) {
    for (const seqKey of flag.supportingSeqs) {
      const event = bySeq.get(seqKey);
      if (event !== undefined) {
        result.add(event.globalIdx);
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// findNextFlag
// ---------------------------------------------------------------------------

/**
 * Find the globalIdx of the next flagged event strictly after `currentGlobalIdx`.
 * A "flagged event" is one whose globalIdx appears in `flaggedSet`.
 *
 * Returns null if no such event exists.
 */
export function findNextFlag(
  events: readonly IndexedEvent[],
  currentGlobalIdx: number,
  flaggedSet: ReadonlySet<number>,
): number | null {
  for (const e of events) {
    if (e.globalIdx > currentGlobalIdx && flaggedSet.has(e.globalIdx)) {
      return e.globalIdx;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// findNextFileSwitch
// ---------------------------------------------------------------------------

/**
 * Find the globalIdx of the next "file switch" event strictly after
 * `currentGlobalIdx`.
 *
 * Definition: a file switch is the first event (with a `file` attribute) after
 * `currentGlobalIdx` whose `file` value differs from the `file` of the
 * most-recently-seen event (with a `file` attribute) at or before
 * `currentGlobalIdx`.
 *
 * If no event at or before `currentGlobalIdx` has a `file` attribute, then
 * any event with a `file` attribute after `currentGlobalIdx` counts as a file
 * switch.
 *
 * `events` must be in chronological order (ascending globalIdx).
 *
 * Returns null if no file switch exists after `currentGlobalIdx`.
 */
export function findNextFileSwitch(
  events: readonly IndexedEvent[],
  currentGlobalIdx: number,
): number | null {
  // Determine the current file: the `file` of the last event (with a file
  // attribute) at or before currentGlobalIdx.
  let currentFile: string | undefined;
  for (const e of events) {
    if (e.globalIdx > currentGlobalIdx) break;
    if (e.file !== undefined) {
      currentFile = e.file;
    }
  }

  // Find the next event after currentGlobalIdx where the file changes.
  for (const e of events) {
    if (e.globalIdx <= currentGlobalIdx) continue;
    if (e.file !== undefined && e.file !== currentFile) {
      return e.globalIdx;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// countRemaining helpers (used for button tooltips)
// ---------------------------------------------------------------------------

/**
 * Count the number of paste-shaped events (native `paste` + `doc.change`
 * with paste-classified `source`) strictly after `currentGlobalIdx`.
 */
export function countRemainingPastes(
  events: readonly IndexedEvent[],
  currentGlobalIdx: number,
): number {
  let count = 0;
  for (const e of events) {
    if (e.globalIdx > currentGlobalIdx && isPasteShaped(e)) count++;
  }
  return count;
}

/**
 * Count the number of `fs.external_change` events strictly after `currentGlobalIdx`.
 */
export function countRemainingExternalChanges(
  events: readonly IndexedEvent[],
  currentGlobalIdx: number,
): number {
  let count = 0;
  for (const e of events) {
    if (e.globalIdx > currentGlobalIdx && e.kind === 'fs.external_change') count++;
  }
  return count;
}

/**
 * Count the number of flagged events strictly after `currentGlobalIdx`.
 */
export function countRemainingFlags(
  events: readonly IndexedEvent[],
  currentGlobalIdx: number,
  flaggedSet: ReadonlySet<number>,
): number {
  let count = 0;
  for (const e of events) {
    if (e.globalIdx > currentGlobalIdx && flaggedSet.has(e.globalIdx)) count++;
  }
  return count;
}

/**
 * Count the number of file-switch events strictly after `currentGlobalIdx`.
 */
export function countRemainingFileSwitches(
  events: readonly IndexedEvent[],
  currentGlobalIdx: number,
): number {
  // Determine the file at currentGlobalIdx.
  let currentFile: string | undefined;
  for (const e of events) {
    if (e.globalIdx > currentGlobalIdx) break;
    if (e.file !== undefined) currentFile = e.file;
  }

  let count = 0;
  let prevFile = currentFile;
  for (const e of events) {
    if (e.globalIdx <= currentGlobalIdx) continue;
    if (e.file !== undefined && e.file !== prevFile) {
      count++;
      prevFile = e.file;
    }
  }
  return count;
}
