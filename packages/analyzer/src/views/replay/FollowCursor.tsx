/**
 * FollowCursor — keeps the student's caret in view as the replay plays.
 *
 * Headless component (returns null), mirroring CursorMarker and
 * GutterDecorations: it drives a side effect on the Monaco editor and renders
 * nothing.
 *
 * Behaviour: whenever the caret position changes, scroll it back into view and
 * centre it — but ONLY if it has left the viewport. Typing inside the visible
 * window causes no scrolling at all, so there is no per-keystroke jitter.
 *
 * Why no "follow on/off" toggle: the reveal fires only when the caret position
 * changes, which only happens when the playhead moves (play, step, scrub,
 * sidebar seek, jump-to-next-paste, file switch). A reviewer who scrolls away
 * while paused is therefore never yanked back until they move the playhead
 * themselves.
 *
 * `content` is a dependency, not just a prop we ignore: on a file-tab switch
 * @monaco-editor/react calls model.setValue(), which resets the viewport to the
 * top. Re-revealing when the content changes undoes that reset even when the
 * caret coordinates happen to be unchanged.
 */

import { useEffect } from 'react';
import type { editor as MonacoEditorNS } from 'monaco-editor';
import { caretPosition } from './cursor-position.js';
import type { ReplaySelection } from './cursor-position.js';

/**
 * monaco.editor.ScrollType.Immediate. Hard-coded rather than threaded through
 * as a second prop because the `monaco` namespace object is null for the first
 * render, which is exactly when the first reveal needs to happen. Immediate
 * (not Smooth) so fast playback doesn't queue scroll animations it can't keep
 * up with.
 */
const SCROLL_TYPE_IMMEDIATE = 1;

type FollowCursorProps = {
  /** The Monaco editor instance (null while the editor is loading). */
  editor: MonacoEditorNS.IStandaloneCodeEditor | null;
  /** The student's cursor/selection at the playhead, or null to leave the viewport alone. */
  selection: ReplaySelection | null;
  /** Content of the shown file. A change means the model was replaced. */
  content: string;
};

export function FollowCursor({ editor, selection, content }: FollowCursorProps) {
  useEffect(() => {
    if (editor === null || selection === null) return;
    editor.revealPositionInCenterIfOutsideViewport(caretPosition(selection), SCROLL_TYPE_IMMEDIATE);
    // `content` is intentionally in the dep list: see the file header.
  }, [editor, selection, content]);

  return null;
}
