/**
 * LineHoverProvider — registers a Monaco hover provider that shows per-line
 * provenance attribution on hover.
 *
 * This is a "headless" React component: it returns null but uses a useEffect
 * to register/unregister the Monaco hover provider via the monaco-editor API.
 *
 * Hover content format:
 *   "Last modified at t={t}ms, kind=<paste|typed|external_change>, seq=#{seq}"
 *
 * Design:
 *   - The hover provider is registered once per (editor, fileState, ordered) tuple.
 *   - The effect returns a cleanup that disposes the provider on unmount or
 *     when deps change (the new effect re-registers with fresh data).
 *   - `linesWithProvenance` is computed ONCE per fileState change and captured
 *     in the provider's closure (A33 perf note: avoid recomputing per hover call).
 *
 * PRD ref: §7.2 (hover line attribution).
 */

import { useEffect } from 'react';
import type { editor as MonacoEditorNS, IDisposable } from 'monaco-editor';
import type * as Monaco from 'monaco-editor';
import { linesWithProvenance } from '@provenance/analysis-core/index/provenance-utils.js';
import { hoverContentFor } from './replay-decoration-utils.js';
import type { FileReplayState } from '@provenance/analysis-core/index/reconstruct-file-provenance.js';
import type { IndexedEvent } from '@provenance/analysis-core/index/event-index.js';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

type LineHoverProviderProps = {
  /** The Monaco editor instance (null while loading). */
  editor: MonacoEditorNS.IStandaloneCodeEditor | null;
  /**
   * The monaco global (loaded via @monaco-editor/react's onMount callback).
   * Needed to call `monaco.languages.registerHoverProvider`.
   */
  monaco: typeof Monaco | null;
  /** Current file state at the engine's position. */
  fileState: FileReplayState | null;
  /** Language (e.g., 'python') used to scope the hover provider. */
  language: string;
  /** All events in chronological order (for event lookup by globalIdx). */
  orderedEvents: readonly IndexedEvent[];
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Registers a Monaco hover provider showing provenance for the hovered
 * character. Returns null — this component is purely a side-effect driver.
 *
 * The provider is per-language, not per-editor instance. It is registered
 * (and re-registered on deps changes) via `monaco.languages.registerHoverProvider()`.
 * Re-registration happens when `fileState`, `orderedEvents`, or `language` changes;
 * the old provider is disposed and a new one is registered with fresh closures.
 *
 * Known limitation (Phase 14):
 *   During rapid state changes (e.g., scrubbing through events quickly), the
 *   cleanup-then-register dance creates brief windows where the hover provider
 *   is unregistered. In these moments, hovering over code shows no provenance
 *   (hover box appears empty). This is a cosmetic limitation for single-editor
 *   scenarios. Multi-editor support for the same language (Phase 15 or v2.1)
 *   would need a model-keyed registration scheme to avoid re-registration.
 */
export function LineHoverProvider({
  editor,
  monaco,
  fileState,
  language,
  orderedEvents,
}: LineHoverProviderProps) {
  useEffect(() => {
    if (editor === null || monaco === null || fileState === null) return;

    // Pre-compute per-line data ONCE (A33 perf note: don't recompute per hover).
    const lines = linesWithProvenance(fileState);

    let disposable: IDisposable | null = null;

    disposable = monaco.languages.registerHoverProvider(language, {
      provideHover(model, position) {
        // Only handle hovers on the model this editor is showing.
        if (model !== editor.getModel()) return null;

        const lineIdx = position.lineNumber - 1; // 0-based
        const line = lines[lineIdx];
        if (!line) return null;

        const charIdx = position.column - 1; // 0-based within line
        if (charIdx < 0 || charIdx >= line.provenance.length) return null;

        // Compute flat offset: sum of all prior line lengths + 1 for each '\n'.
        let offset = 0;
        for (let i = 0; i < lineIdx; i++) {
          offset += (lines[i]?.text.length ?? 0) + 1; // +1 for '\n'
        }
        offset += charIdx;

        const text = hoverContentFor(offset, fileState, orderedEvents);
        if (text === null) return null;

        return {
          range: {
            startLineNumber: position.lineNumber,
            startColumn: 1,
            endLineNumber: position.lineNumber,
            endColumn: model.getLineMaxColumn(position.lineNumber),
          },
          contents: [{ value: `\`${text}\`` }],
        };
      },
    });

    return () => {
      if (disposable !== null) {
        try {
          disposable.dispose();
        } catch {
          // Provider may already be gone — ignore.
        }
        disposable = null;
      }
    };
  }, [editor, monaco, fileState, language, orderedEvents]);

  return null;
}
