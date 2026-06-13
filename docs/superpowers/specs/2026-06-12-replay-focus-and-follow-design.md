# Replay: focus-away overlay + auto-follow edited file

**Date:** 2026-06-12
**Status:** Approved design
**Affects:** `packages/analyzer` (replay views only)

## Problem

The replay views give no signal when a student was focused away from the VS Code
window, and they don't follow edits across files — the viewer must manually pick
the file tab to see where work is happening.

## Key architectural fact

Both replay views (the v3 submission drill-in `views/submission/Replay.tsx` and the
v2 `/local` `views/replay/ReplayView.tsx`) render the **same shared `ReplayInner`**
component on top of one shared engine (`useReplayEngine` / `engine-core`). Implement
both features once in `ReplayInner` (+ pure helpers) and both views inherit them.

## Feature 1 — "Focused away" overlay

`focus.change` carries `{ gained: boolean; reason?: string }` and no file path. The
student is "away" whenever the most recent `focus.change` at-or-before the playhead
has `gained: false` and no later `gained: true` has occurred yet (within the played
session).

- While the playhead is inside such a span, render a persistent overlay over the
  **code pane only** (not the transport bar): `absolute inset-0`, `pointer-events:none`,
  a semi-transparent red tint, with a centered badge reading **"Focused away from
  window"** (append the `reason` when present, e.g. "window"/"tab").
- The overlay clears the instant the playhead reaches the matching `gained: true`
  (or persists to session end if focus is never regained).
- Driven purely by playhead + events; no engine changes. Mirrors the existing
  `ColorLegend` absolute-overlay-inside-the-editor-pane pattern.

## Feature 2 — Auto-follow the edited file

`ReplayInner` already has `activeFile`/`setActiveFile` selecting which file Monaco
shows (`resolvedFile = activeFile ?? files[0]`). Compute the "current edited file" =
the file of the most recent file-bearing event (`doc.change` / `paste` / `doc.save`
/ `doc.open`) at-or-before the playhead. When that value **changes**, call
`setActiveFile` to it.

- Consequence (approved): while paused, a manual tab click sticks because the
  playhead isn't moving; as soon as the playhead crosses into a different file's
  event, the view follows. "Follow the action" during play without fighting a paused
  manual selection.
- Rejected alternative: force the active file every frame — overrides manual clicks
  even when paused.

## Implementation shape

- Two pure helpers next to `views/replay/jump-predicates.ts` (or a new
  `focus-and-follow.ts`), unit-tested in isolation:
  - `currentFocusAwaySpan(events, currentGlobalIdx)` → the active focus-lost span (or
    null) + its `reason`.
  - `currentEditedFile(events, currentGlobalIdx)` → file path or null.
    Both take the session's ordered events (or `index.ordered`) and the playhead.
- `ReplayInner`: a `useEffect` that calls `setActiveFile` when `currentEditedFile`
  changes; and a conditional overlay element inside the editor container driven by
  `currentFocusAwaySpan`.
- Styling via Tailwind + a small `globals.css` class if needed (matching the existing
  `replay-*` decoration classes).

## Non-goals

- No timeline/scrubber markers for focus changes (could come later).
- No change to the playback engine, event index, or recorder.

## Testing

- Unit-test the two pure helpers: away-span detection (lost→regain, lost-never-regain,
  before-first-event, multiple toggles), and current-edited-file (last file-bearing
  event wins; non-file events skipped; before-first-event → null).
- A lightweight render test of `ReplayInner` asserting the overlay appears within an
  away span and the active file follows a cross-file edit (mirrors existing
  `Replay.test.tsx` setup).
