/**
 * external-change-focus.ts — pure helpers behind "show me where the external
 * change landed" during replay.
 *
 * The replay viewport normally follows the student's caret (see FollowCursor).
 * An `fs.external_change` has no caret: it is something OUTSIDE the editor
 * writing the file, so nothing moves the cursor to it and the reviewer can play
 * straight past the single highest-signal event in the bundle without ever
 * seeing the lines it touched.
 *
 * These two helpers compute a viewport target for that case. The caller reveals
 * it instead of the caret while it is non-null, and reverts to the caret as soon
 * as it goes away — so the viewport jumps to the external change, then returns.
 *
 * Both are pure (no React, no Monaco). Recorder PRD §4.5.
 */

import type { IndexedEvent } from '@provenance/analysis-core/index/event-index.js';
import type { FileReplayState } from '@provenance/analysis-core/index/reconstruct-file-provenance.js';
import type { MonacoPositionLiteral } from './cursor-position.js';

/**
 * Event kinds that hand the viewport back to the caret.
 *
 * These are the things the STUDENT does: typing, pasting, moving the cursor.
 * Once any of them happens, the reviewer's attention should be back on the
 * student, so the external change stops holding the viewport.
 *
 * `doc.save` is deliberately absent. The recorder emits the save from the same
 * continuation as the external change — in a real bundle they routinely share a
 * wall-clock timestamp — so counting it would end the reveal in the same tick it
 * began and the jump would never be visible.
 */
const RETURN_TO_CARET_KINDS = new Set<string>(['doc.change', 'paste', 'selection.change']);

/**
 * The `fs.external_change` currently holding the viewport for `filePath`, or
 * null.
 *
 * An external change holds the viewport from the moment the playhead reaches it
 * until the student's next edit or cursor move in that file. Scanning backwards
 * from the playhead, that is: an `fs.external_change` reached before any
 * `RETURN_TO_CARET_KINDS` event.
 *
 * Derived purely from the playhead, with no timers and no retained state, so it
 * behaves identically whether the reviewer is playing, paused, stepping or
 * scrubbing — and a reviewer who scrubs backwards onto an external change sees
 * it framed the same way as one who played into it.
 *
 * `events` must be chronologically ordered (ascending `globalIdx`), as the
 * per-session event lists from the EventIndex are.
 */
export function currentExternalChange(
  events: readonly IndexedEvent[],
  currentGlobalIdx: number,
  filePath: string | null,
): IndexedEvent | null {
  if (filePath === null) return null;

  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.globalIdx > currentGlobalIdx) continue;
    if (e.file !== filePath) continue;
    if (RETURN_TO_CARET_KINDS.has(e.kind)) return null;
    if (e.kind === 'fs.external_change') return e;
  }
  return null;
}

/**
 * Where to scroll to show `event`'s handiwork, in 1-based Monaco coordinates, or
 * null when the bundle cannot say.
 *
 * The position is the first character the replay attributes to this event, which
 * is exactly what the gutter paints — so the viewport lands on the decorated
 * region rather than near it.
 *
 * Returns null in two cases, both of which must fall back to the caret rather
 * than guess:
 *
 *   - The event is not in `kindByGlobalIdx` at all. Reconstruction classified it
 *     as the recorder reporting the editor's own save (D1/D1b/D1c), so there is
 *     nothing to look at.
 *   - It is present but no character references it — the sentinel case. The
 *     recorder only inlines `new_content` under its cap (4 KB through recorder
 *     1.1.x, 64 KB after), so for a genuine external write to a source file of
 *     any size the post-change bytes were never recorded. The event is real and
 *     still flagged; its POSITION is simply not in the evidence, and no amount
 *     of analyzer work can recover it.
 */
export function externalChangePosition(
  state: FileReplayState | null,
  event: IndexedEvent | null,
): MonacoPositionLiteral | null {
  if (state === null || event === null) return null;
  if (state.kindByGlobalIdx.get(event.globalIdx) !== 'external_change') return null;

  const target = event.globalIdx;
  const prov = state.provenance;
  for (let offset = 0; offset < prov.length; offset++) {
    if (prov[offset] !== target) continue;
    return offsetToPosition(state.content, offset);
  }
  return null;
}

/** Convert a character offset into 1-based Monaco line/column. */
function offsetToPosition(content: string, offset: number): MonacoPositionLiteral {
  let lineNumber = 1;
  let lineStart = 0;
  for (let i = 0; i < offset; i++) {
    if (content.charCodeAt(i) === 0x0a /* \n */) {
      lineNumber++;
      lineStart = i + 1;
    }
  }
  return { lineNumber, column: offset - lineStart + 1 };
}
