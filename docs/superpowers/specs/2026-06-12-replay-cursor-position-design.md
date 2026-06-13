# Replay: show student cursor position + selection

**Date:** 2026-06-12
**Status:** Approved design
**Affects:** `packages/analyzer` (replay views only)
**Related:** `2026-06-12-replay-focus-and-follow-design.md` (same shared `ReplayInner`)

## Problem

The replay views reconstruct file content at the playhead but don't show where the
student's cursor/selection was — context that matters (e.g. selecting a block right
before a paste or delete).

## Data available

The recorder emits `selection.change` events (unthrottled, every cursor move) with
`{ path, range, was_selection }`, where `range` is `{ start, end }` in 0-based LSP
coordinates. These are file-bearing and live in `index.byFile` and the per-session
`index.bySessionId` array (the same `sessionEvents` the replay already uses). A bare
cursor is `was_selection: false` (start === end); a real selection is `true`.

## Behavior

At the playhead, find the **most recent `selection.change` for the active (followed)
file at-or-before the playhead** and render in Monaco:

- a **caret marker** (thin vertical line) at the cursor column, and
- when `was_selection` is true, a **highlight** over the selected range, with the
  caret at the range `end`.

Nothing renders when the most recent selection belongs to a different file than the
one shown, or when no `selection.change` has occurred yet.

## Rendering — decoration-based

Mirror the existing `GutterDecorations` headless pattern (a `null`-returning component
driving `editor.deltaDecorations`), NOT Monaco's native `editor.setSelection`.

- Rationale: a read-only editor may not render a native caret; decorations give
  guaranteed visibility, a custom color consistent with the existing `replay-*`
  overlays, and never fight a user clicking around the read-only editor.
- The zero-width caret is drawn with a Monaco `beforeContentClassName` pseudo-element
  (a 2px line). The selection is a normal range decoration (`inlineClassName`).

## Pieces (all in `packages/analyzer/src/views/replay/`)

- `cursor-position.ts` — pure helpers:
  - `currentSelection(sessionEvents, currentGlobalIdx, filePath)` →
    `{ range, wasSelection } | null` (most recent `selection.change` for `filePath`
    at-or-before the playhead).
  - `toMonacoRange(range)` — 0-based LSP `{start,end}` → Monaco 1-based
    `{ startLineNumber, startColumn, endLineNumber, endColumn }`.
- `CursorMarker.tsx` — headless component; props `editor` + the computed selection.
  Builds the caret + (optional) selection decorations, syncs via `deltaDecorations`,
  clears on unmount / when selection is null.
- `ReplayView.tsx` — memoize `currentSelection(sessionEvents, currentGlobalIdx,
resolvedFile)`, render `<CursorMarker editor={monacoEditor} selection={…} />` next
  to `GutterDecorations`.
- `globals.css` — `.replay-cursor-caret` (blue 2px line via `::before`) and
  `.replay-cursor-selection` (blue tint), matching the existing decoration classes.

## Non-goals

- No multi-cursor support (recorder captures only the first selection).
- No engine/recorder/index changes.

## Testing

- Unit-test `currentSelection`: most-recent-for-file wins; filters other files and
  non-selection kinds; null before any selection / before first event; `was_selection`
  passthrough.
- Unit-test `toMonacoRange`: 0→1 conversion; zero-width caret (start === end).
- A light render test (mirroring `ReplayView.test.tsx`): the cursor marker testid
  appears once a `selection.change` precedes the playhead for the shown file.
