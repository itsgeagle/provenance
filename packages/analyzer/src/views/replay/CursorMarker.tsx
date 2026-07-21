/**
 * CursorMarker — renders the student's cursor (and selection) in the replay editor
 * via Monaco decorations.
 *
 * Headless component (returns null), mirroring GutterDecorations: it drives
 * editor.deltaDecorations() from the current ReplaySelection and cleans up on unmount.
 *
 *   - bare cursor (wasSelection false): a zero-width caret at the cursor column.
 *   - selection (wasSelection true): a highlight over the selected range plus a caret
 *     at the selection end.
 *
 * The caret is a Monaco `beforeContentClassName` pseudo-element; the highlight is an
 * `inlineClassName` range. CSS classes (.replay-cursor-caret, .replay-cursor-selection)
 * live in globals.css — Monaco's DOM is outside React's tree so Tailwind does not apply.
 */

import { useEffect, useRef } from 'react';
import type { editor as MonacoEditorNS } from 'monaco-editor';
import { toMonacoRange, caretPosition } from './cursor-position.js';
import type { ReplaySelection } from './cursor-position.js';

type CursorMarkerProps = {
  /** The Monaco editor instance (null while the editor is loading). */
  editor: MonacoEditorNS.IStandaloneCodeEditor | null;
  /** The student's cursor/selection at the playhead, or null to clear. */
  selection: ReplaySelection | null;
};

function buildDecorations(selection: ReplaySelection): MonacoEditorNS.IModelDeltaDecoration[] {
  const m = toMonacoRange(selection.range);
  // Caret sits at the cursor: the selection end for a real selection, else the
  // (equal) start/end of a bare cursor. Shared with FollowCursor so the painted
  // caret and the revealed position can never disagree.
  const { lineNumber: caretLine, column: caretCol } = caretPosition(selection);

  const decorations: MonacoEditorNS.IModelDeltaDecoration[] = [
    {
      range: {
        startLineNumber: caretLine,
        startColumn: caretCol,
        endLineNumber: caretLine,
        endColumn: caretCol,
      },
      options: { beforeContentClassName: 'replay-cursor-caret', stickiness: 1 },
    },
  ];

  if (selection.wasSelection) {
    decorations.unshift({
      range: m,
      options: { inlineClassName: 'replay-cursor-selection', stickiness: 1 },
    });
  }

  return decorations;
}

export function CursorMarker({ editor, selection }: CursorMarkerProps) {
  const decorationIdsRef = useRef<string[]>([]);

  useEffect(() => {
    if (editor === null) return;
    const decorations = selection !== null ? buildDecorations(selection) : [];
    const newIds = editor.deltaDecorations(decorationIdsRef.current, decorations);
    decorationIdsRef.current = newIds;
  }, [editor, selection]);

  // Cleanup on unmount (captures editor via a ref, same pattern as GutterDecorations).
  const editorRef = useRef<MonacoEditorNS.IStandaloneCodeEditor | null>(null);
  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  useEffect(() => {
    return () => {
      const ed = editorRef.current;
      if (ed !== null && decorationIdsRef.current.length > 0) {
        try {
          ed.deltaDecorations(decorationIdsRef.current, []);
        } catch {
          // Editor may already be disposed on unmount — ignore.
        }
        decorationIdsRef.current = [];
      }
    };
  }, []); // empty deps: cleanup runs only on unmount

  return null;
}
