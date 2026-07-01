/**
 * GutterDecorations — Monaco deltaDecorations synced to the current provenance
 * array.
 *
 * This is a "headless" React component: it renders nothing (returns null) but
 * uses a useEffect to call editor.deltaDecorations() whenever the file state
 * changes.
 *
 * Design:
 *   - Keeps a ref of the current decoration IDs so they can be replaced on
 *     the next update (Monaco's API: `editor.deltaDecorations(oldIds, newDecos)`).
 *   - On unmount, removes all decorations by passing empty array as new decorations.
 *   - CSS classes (.replay-paste-region, .replay-external-region) are in
 *     globals.css — Monaco's DOM lives outside React's tree so Tailwind scoping
 *     does not apply.
 *
 * PRD ref: §7.2 (color-coded gutter).
 */

import { useEffect, useRef } from 'react';
import type { editor as MonacoEditorNS } from 'monaco-editor';
import { runsFromProvenance } from './replay-decoration-utils.js';
import type { FileReplayState } from '@provenance/analysis-core/index/reconstruct-file-provenance.js';

// ---------------------------------------------------------------------------
// CSS class map
// ---------------------------------------------------------------------------

const KIND_CLASS: Record<'paste' | 'external_change', string> = {
  paste: 'replay-paste-region',
  external_change: 'replay-external-region',
};

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

type GutterDecorationsProps = {
  /** The Monaco editor instance (null while the editor is loading). */
  editor: MonacoEditorNS.IStandaloneCodeEditor | null;
  /** Current file state at the engine's position. */
  fileState: FileReplayState | null;
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Syncs Monaco gutter decorations to `fileState.provenance`.
 *
 * Rendered inside <ReplayViewInner> after the Monaco editor mounts.
 * Returns null — this component is purely a side-effect driver.
 */
export function GutterDecorations({ editor, fileState }: GutterDecorationsProps) {
  // Keep track of the current set of decoration IDs so we can replace them.
  const decorationIdsRef = useRef<string[]>([]);

  useEffect(() => {
    if (editor === null) return;

    const runs = fileState !== null ? runsFromProvenance(fileState) : [];

    const newDecorations: MonacoEditorNS.IModelDeltaDecoration[] = runs.map((run) => ({
      range: {
        startLineNumber: run.startLineNumber,
        startColumn: run.startColumn,
        endLineNumber: run.endLineNumber,
        endColumn: run.endColumn,
      },
      options: {
        // inlineClassName applies the CSS class to the text characters in the
        // range (not to the gutter margin). This is correct for background-
        // color overlays over the code text.
        inlineClassName: KIND_CLASS[run.kind],
        // stickiness: NeverGrowsWhenTypingAtEdges (value 1) prevents the
        // decoration from expanding when the editor is in read-only mode.
        stickiness: 1,
      },
    }));

    // deltaDecorations returns the new decoration IDs; store for next call.
    const newIds = editor.deltaDecorations(decorationIdsRef.current, newDecorations);
    decorationIdsRef.current = newIds;
  }, [editor, fileState]);

  // Separate cleanup effect that captures editor in a ref.
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
