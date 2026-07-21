# Multi-session replay + unified events page

**Date:** 2026-07-20
**Status:** Approved, not yet implemented
**Scope:** `packages/analyzer` only. No changes to `log-core`, `analysis-core`, `shared`, `server`, or `recorder`.

## Problem

A submission bundle contains one `.slog` per recorder session. A student who works
across several VS Code launches produces several sessions. The analyzer indexes them
correctly — `EventIndex.ordered` is already a single chronological stream across all
sessions, and `globalIdx` is already a stable whole-bundle identity — but two UI
surfaces throw that away.

### P1. Replay is locked to one session

`createEngine(index, sessionId)` (`views/replay/engine-core.ts:272`) pulls
`index.bySessionId.get(sessionId)` and never looks outside it. Consequences:

- **File tabs vanish.** `computeFiles()` derives the tab strip from the current
  session's events only. A file edited in session 1 and untouched in session 2
  disappears from the tab strip in session 2 — even though its content is still
  fully reconstructable, because `reconstructFileWithProvenance` already walks
  `index.byFile` across the whole bundle.
- **The Events sidebar dead-ends.** `EventSidebar` is virtualized and scrollable, but
  it is fed `sessionEvents`, so it stops at the session boundary. There is no way to
  scroll into the adjacent session.
- **Playback stops at every boundary.** The transport scrubs one session.
- **The inter-session seam is unreachable.** The `inter_session_external_change`
  heuristic (`analysis-core/src/heuristics/inter-session-external-change.ts`) detects
  file content that diverged between one session's end and the next session's first
  `doc.open`. That moment is precisely a seam — and today the replay playhead can
  never be positioned at it.

### P2. The server-backed events page is a stub

`views/submission/Timeline.tsx` is a bespoke simplified list. Its own header comment
says so: _"A simplified event list (not the full v2 TimelineView with Monaco).
Phase 24/25 can integrate deeper with the v2 primitives."_ It:

- caps at 500 rows (`events.slice(0, 500)`, line 84) over a `useEvents()` query
  already hard-capped at `limit=2000` — so large submissions silently show a
  fraction of their events with no indication anything was dropped;
- has no detail pane, no jump-to-replay, no session filter, no virtualization;
- filters on a `COMMON_KINDS` list containing `doc.paste`, **which is not a real
  event kind** (the real kind is `paste`), so that button has never matched anything.

Meanwhile the `/local` route has the full experience: `FilterBar` + virtualized
`EventList` + `EventDetail` + jump-to-replay, all driven off an `EventIndex`.

### The precedent that makes P2 cheap

The server-backed **Replay** tab already solved the "server rows → EventIndex"
problem. `data/useFullEventIndex.ts` pages `GET /submissions/:id/events` to
exhaustion and calls `buildIndexFromEventRows`, producing a real `EventIndex`;
`views/submission/Replay.tsx` then mounts the _same_ `ReplayInner` the local route
uses. Timeline simply never got that treatment.

## Design

### Part 1 — Whole-bundle replay engine

#### 1.1 New module: `views/replay/bundle-clock.ts`

Pure, analyzer-local, no React, no timers.

```ts
type Seam = {
  /** globalIdx of the FIRST event of the next session. */
  atGlobalIdx: number;
  prevSessionId: string;
  nextSessionId: string;
  /** Real wall-clock gap in ms (may be negative under clock skew). */
  realGapMs: number;
  /** Gap as rendered during playback, in ms. */
  collapsedGapMs: number;
};

type BundleClock = {
  /** Indexed by globalIdx. Strictly non-decreasing. */
  bundleT: Float64Array;
  seams: Seam[];
};

function buildBundleClock(
  ordered: readonly IndexedEvent[],
  opts?: { maxSeamGapMs?: number },
): BundleClock;
```

Derivation:

- **Within a session:** accumulate `t` deltas. `t` is monotonic relative to session
  start and immune to wall-clock skew, so within-session playback timing is
  bit-identical to today's behavior.
- **Across a seam:** `realGapMs = Date.parse(wall[next]) - Date.parse(wall[prev])`.
  `collapsedGapMs = clamp(realGapMs, SEAM_FLOOR_MS, maxSeamGapMs)`.
- **Defaults:** `maxSeamGapMs = 5_000`, `SEAM_FLOOR_MS = 1_000`.
- **Skew guard:** if `realGapMs` is negative, `NaN`, or unparseable, use
  `SEAM_FLOOR_MS`. Cross-machine clock skew is a real condition in this system —
  the `clock_jumps` heuristic exists for it — so the clock must not produce a
  non-monotonic `bundleT`.

Every inter-session gap renders as a fixed ~5 s pause regardless of real duration.
The true duration is never lost: it is displayed on the seam divider and in the
seam tick tooltip.

**Why analyzer-local and not `analysis-core`:** `analysis-core` is consumed by the
server, and `IndexedEvent` is a shared shape. This is a playback concern with no
analysis meaning. Adding a derived field to a server-consumed contract for a UI
timing decision is not warranted.

#### 1.2 `views/replay/engine-core.ts`

- `createEngine(index)` — the `sessionId` parameter is removed.
  `internal.events = index.ordered`.
- **Array position now equals `globalIdx`.** This deletes the position↔globalIdx
  translation layer (`posForGlobalIdx` and friends around lines 301–313) and the
  compensating logic `TransportBar` documents at lines 36–40. Net simplification.
- `computeFiles()` unions file paths over the whole bundle.
- `tick()` reads `bundleT` instead of `t`; `endVirtualT()` returns the final
  `bundleT` value.
- Checkpointing is unchanged. It is already keyed on `globalIdx` with
  `CHECKPOINT_EVERY = 1000`, and reconstruction already cuts on true `globalIdx`,
  so the checkpoint scheme carries over to a whole-bundle stream without
  modification.
- `ReplayState` keeps a **derived** `currentSessionId` (the session containing the
  playhead) for display purposes. It is no longer an input.

#### 1.3 `views/replay/useReplayEngine.ts`

Signature becomes `useReplayEngine(index)`. The rAF playback loop is otherwise
unchanged — it already drives `engine.tick(virtualDelta)` and end-of-stream
detection off `endVirtualT()`.

#### 1.4 `views/replay/FileTabs.tsx`

All four behaviors, per approved design:

1. **Tabs = every file in the bundle**, from the whole-bundle `computeFiles()`.
   Content shown is always the reconstruction as of the playhead, so a session-1
   file displays its session-1 final state while the playhead sits in session 3.
2. **Last-edited badge per tab.** For file `F` at playhead `g`, find the greatest
   `globalIdx ≤ g` in `index.byFile.get(F)` — that array is already sorted, so
   binary search. Call that event `E`. Rendering rule, in order:
   - `E` is in the current session → wall-clock delta ("2m ago", "1h ago").
   - `E` is in an earlier session → session distance ("1 session ago",
     "3 sessions ago"), measured in `index.bySessionId` key order.
   - No such `E` (file not yet touched at this playhead) → no badge; the tab
     renders in the dimmed state.
3. **Dim files not touched in the current session.** Dimming keys off
   `currentSessionId`, so it updates as the playhead crosses seams.
4. **Active file survives seam crossings.** Selection is no longer reset when the
   playhead enters a new session.

#### 1.5 `views/replay/EventSidebar.tsx`

Fed `index.ordered`. Builds a display array of `(EventRow | SeamRow)` and gives the
virtualizer a variable `estimateSize`: 30 px for events (today's `ROW_HEIGHT`),
~44 px for seam dividers.

A seam divider shows the **real** gap ("4h 12m offline"), not the collapsed one, and
is visually marked when that seam carries an `inter_session_external_change` flag.

Existing auto-scroll behavior (follow `currentGlobalIdx`, don't fight manual
scrolling) is preserved.

#### 1.6 Seam flag surfacing

`inter_session_external_change` flags carry `supportingSeqs` as `${sessionId}:${seq}`
strings, already resolvable to `globalIdx` via `index.bySeq` — and
`jump-predicates.ts:92` already has `buildFlaggedGlobalIdxSet` doing exactly this
resolution. A seam is marked when a supporting event of such a flag is the first
`doc.open` of the seam's next session.

#### 1.7 `views/replay/jump-predicates.ts` + `JumpControls.tsx`

Add `findNextSeam(events, seams, currentGlobalIdx)` and
`countRemainingSeams(seams, currentGlobalIdx)`, matching the existing
`findNextPaste` / `countRemainingPastes` signature style. Wire a seam button into
`JumpControls` alongside the existing paste / external-change / flag / file-switch
controls.

#### 1.8 `views/replay/TransportBar.tsx`

Scrubs the whole bundle. The session-local↔global mapping is deleted (see 1.2).
Seam positions render as ticks on the slider with the real gap in the tooltip.

#### 1.9 Routing

Both replay entry points keep their current URL shape; the session identifier
changes meaning from _scope_ to _entry anchor_.

| Route                      | Today                     | After                                                           |
| -------------------------- | ------------------------- | --------------------------------------------------------------- |
| `/local/replay/:sessionId` | replays only that session | mounts whole-bundle engine, seeks to that session's first event |
| `?tab=replay&session=<id>` | replays only that session | same                                                            |

`?event=<globalIdx>` becomes the position of record. The session `<select>` in
`Replay.tsx:125` becomes a **seek** rather than a remount, and stops clearing the
playback position. All existing deep links continue to resolve.

### Part 2 — Events page unification

Extract the body of `views/timeline/TimelineView.tsx` into a presentational
`TimelineInner({ index, onJumpToReplay })` in `views/timeline/`. Then:

- `views/timeline/TimelineView.tsx` (local): `useBundle()` → `<TimelineInner>`,
  with `onJumpToReplay` navigating to `/local/replay/...`.
- `views/submission/Timeline.tsx` (server): `useFullEventIndex(submissionId)` →
  `<TimelineInner>`, with `onJumpToReplay` navigating to `?tab=replay&event=...`.
  Loading / error / empty states mirror `views/submission/Replay.tsx`.

Jump-to-replay is the only route-dependent behavior, hence the callback prop rather
than a router read inside `TimelineInner`. The `?seq=sessionId:42` deep-link
selection handling stays _inside_ `TimelineInner` — both routes are search-param
based, so it needs no per-route variation.

This deletes the 500-row cap, the ad-hoc `eventSummary`, and the `COMMON_KINDS`
list (including its non-existent `doc.paste` kind). The server tab gains
`EventDetail`, jump-to-replay, session filtering, and virtualization by
construction rather than by reimplementation.

## Error handling

- **Event ceiling.** `useFullEventIndex` throws above `MAX_EVENTS` (200k). The
  Timeline tab renders this as a visible error state. Silently truncating at 500,
  as today, is strictly worse than failing loudly — staff currently have no way to
  know events are missing.
- **Single-session bundles.** `seams` is empty: no dividers, no ticks, seam jump
  control disabled. Playback and file tabs behave exactly as today.
- **Zero-event bundles.** `bundleT` is empty; engine reports `eventCount() === 0`;
  existing empty-state paths apply.
- **Clock skew across sessions.** Handled in `buildBundleClock` (see 1.1);
  `bundleT` is guaranteed non-decreasing regardless of input `wall` values.
- **Unknown session in URL.** Existing "session not present in event stream"
  guards (`ReplayView.tsx:196`, `Replay.tsx:112`) are retained, now applied to the
  entry anchor.

## Testing

New:

- `bundle-clock.test.ts` — monotonicity, seam clamping at both bounds, negative and
  `NaN` gaps, single session, empty input, `maxSeamGapMs` override.
- `FileTabs` — last-edited computation at various playheads, dimming keyed to
  `currentSessionId`, active-file persistence across a seam.
- `EventSidebar` — seam rows inserted at correct positions, variable row sizing,
  flagged-seam marking.
- `jump-predicates` — `findNextSeam` / `countRemainingSeams`, including the
  no-seams case.
- `TimelineInner` — mounted against both a bundle-derived and a rows-derived
  `EventIndex`, asserting identical rendering.
- Regression: `/local/replay/:sessionId` and `?tab=replay&session=` deep links land
  on the correct event under the new whole-bundle engine.

Rewritten (flagged as real cost, not a rename): `engine-core.test.ts` (514 lines)
and `ReplayView.test.tsx` (492 lines) are written against a session-scoped engine
and must be reworked for a whole-bundle one.

Per CLAUDE.md: no existing assertion is weakened to accommodate the new engine. If
a current test encodes session-scoped behavior that this design intentionally
changes, it is rewritten to encode the new behavior explicitly — not deleted or
loosened.

## Phasing

The full change exceeds CLAUDE.md's ~200-line / ~5-file guideline, so it lands as
three independently reviewable phases:

1. **Events page unification** (Part 2). Touches no engine code. Independently
   valuable and independently revertable.
2. **Bundle clock + whole-bundle engine + transport** (1.1–1.3, 1.8, 1.9).
3. **Seam and file-tab UI** (1.4–1.7).

## Non-goals

- No changes to `log-core`, `analysis-core`, `shared`, `server`, or `recorder`.
- No API or schema changes.
- No new heuristics; `inter_session_external_change` is surfaced, not modified.
- No new dependencies.
- Within-session idle gaps keep today's "sit through the gap" playback behavior.
  Only _inter_-session gaps collapse.
- Seam collapse duration is a constant, not user-configurable UI.
