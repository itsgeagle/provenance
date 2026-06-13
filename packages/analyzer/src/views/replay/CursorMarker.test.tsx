/**
 * CursorMarker.test.tsx — verifies the headless component drives
 * editor.deltaDecorations with the right caret/selection decorations.
 *
 * The component returns null, so we assert via a fake editor whose
 * deltaDecorations is a spy (real Monaco isn't available in jsdom).
 */

import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { CursorMarker } from './CursorMarker.js';
import type { ReplaySelection } from './cursor-position.js';
import type { editor as MonacoEditorNS } from 'monaco-editor';

function fakeEditor() {
  const deltaDecorations = vi.fn((_old: string[], next: MonacoEditorNS.IModelDeltaDecoration[]) =>
    next.map((_, i) => `id-${i}`),
  );
  return { deltaDecorations } as unknown as MonacoEditorNS.IStandaloneCodeEditor & {
    deltaDecorations: ReturnType<typeof vi.fn>;
  };
}

const sel = (range: ReplaySelection['range'], wasSelection: boolean): ReplaySelection => ({
  range,
  wasSelection,
});

describe('CursorMarker', () => {
  it('draws a single caret decoration for a bare cursor', () => {
    const ed = fakeEditor();
    render(
      <CursorMarker
        editor={ed}
        selection={sel({ start: { line: 2, character: 4 }, end: { line: 2, character: 4 } }, false)}
      />,
    );
    const decos = ed.deltaDecorations.mock.calls.at(-1)![1];
    expect(decos).toHaveLength(1);
    expect(decos[0].options.beforeContentClassName).toBe('replay-cursor-caret');
    // 0-based (2,4) → Monaco 1-based (3,5), zero-width
    expect(decos[0].range).toEqual({
      startLineNumber: 3,
      startColumn: 5,
      endLineNumber: 3,
      endColumn: 5,
    });
  });

  it('draws a selection highlight plus a caret at the selection end', () => {
    const ed = fakeEditor();
    render(
      <CursorMarker
        editor={ed}
        selection={sel({ start: { line: 1, character: 0 }, end: { line: 3, character: 6 } }, true)}
      />,
    );
    const decos = ed.deltaDecorations.mock.calls.at(-1)![1];
    expect(decos).toHaveLength(2);
    // first: the selection highlight over the full range
    expect(decos[0].options.inlineClassName).toBe('replay-cursor-selection');
    expect(decos[0].range).toEqual({
      startLineNumber: 2,
      startColumn: 1,
      endLineNumber: 4,
      endColumn: 7,
    });
    // second: caret at the selection end
    expect(decos[1].options.beforeContentClassName).toBe('replay-cursor-caret');
    expect(decos[1].range).toEqual({
      startLineNumber: 4,
      startColumn: 7,
      endLineNumber: 4,
      endColumn: 7,
    });
  });

  it('clears decorations when selection is null', () => {
    const ed = fakeEditor();
    render(<CursorMarker editor={ed} selection={null} />);
    const decos = ed.deltaDecorations.mock.calls.at(-1)![1];
    expect(decos).toEqual([]);
  });

  it('does nothing when the editor is not yet mounted', () => {
    // Should not throw when editor is null.
    expect(() =>
      render(
        <CursorMarker
          editor={null}
          selection={sel(
            { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            false,
          )}
        />,
      ),
    ).not.toThrow();
  });
});
