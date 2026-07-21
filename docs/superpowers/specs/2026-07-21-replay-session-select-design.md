# Replay session select — live indicator + seek control

**Date:** 2026-07-21
**Status:** Designed
**Scope:** `packages/analyzer` only. No changes to `log-core`, `analysis-core`, `shared`,
`server`, or `recorder`.
**Follows:** `2026-07-20-multi-session-replay-and-events-design.md` (§1.9 in particular)

## Problem

The multi-session replay work changed `sessionId` from a **scope** into an **entry
anchor**: `createEngine(index)` now runs the whole bundle and `?event=<globalIdx>` is
the position of record. Two UI surfaces were built against the old meaning and were
not updated with it.

### P1. Selecting a session does nothing

Both switchers are dead controls.

`ReplayView.tsx:104` handles the local switcher by calling
`navigate('/local/replay/<id>')`. `Replay.tsx:136-138` handles the server switcher by
writing `?event=<firstGlobalIdx>` into the search params. Neither reaches the engine,
because the only URL→engine seek is mount-only:

```ts
// ReplayView.tsx:386-411
const didInitRef = useRef(false);
useEffect(() => {
  if (didInitRef.current) return;
  didInitRef.current = true;
  /* ...read ?event= / anchor, seek... */
}, []);
```

React Router does not remount `ReplayView` on a route-param change and nothing keys
`<ReplayInner>`, so `didInitRef` stays `true` and the effect never re-fires. The
`<select>` value flips, the label repaints, the playhead does not move.

Verified against a 4-event / 2-session bundle: after switching `sess1` → `sess2`, the
transport slider still reports `aria-valuenow="0"` and the event readout still says
`1 of 4`.

The existing test `ReplayView.test.tsx:430` ("changing the switcher navigates to the
other session") asserts only `select.value === 'sess2'` — the widget's own state, not
the navigation — which is why this was not caught.

### P2. What the bars display is wrong the moment playback starts

The `<select>` value, the option label, and the `N / M` ordinal all derive from the
**route/query param**, not the playhead:

- `ReplayView.tsx:99` — `ordinal = sessionIds.indexOf(sessionId) + 1`, where
  `sessionId` is the route param.
- `Replay.tsx:63-66` — `sessionId` resolved from `?session=`.

Play across a seam and the header still reads "Session 1 of 2". Enter at `sess2` and
it reads `2 / 2` while the playhead sits at globalIdx 0 inside session 1.

The truthful value already exists. `engine-core.ts:397-407` derives
`state.sessionId` — the session containing the playhead — and `ReplayInner` already
passes it to `FileTabs` (`ReplayView.tsx:515`). The header simply never received it.

### P3. Two divergent implementations of the same control

`ReplayHeader` (local) and the bar in `Replay.tsx` (server) render different labels,
different option text, different markup, and derive their option list from different
sources. They will keep drifting.

### What is _not_ the problem

Adjacent-session movement is already well covered by the seam work in `f72582f`:
seam ticks on the transport, seam dividers with real gap durations in the event
sidebar, the `⏭ Session` jump button, and per-tab "3 sessions ago" badges. The job
left for a session control is **random access** ("take me to session 7 of 12" —
`findNextSeam` is forward-only) and **at-a-glance position** ("which session am I in
right now").

## Design

One component, owned by `ReplayInner`, driven by engine state, seeking rather than
navigating.

### 1. New: `views/replay/SessionSelect.tsx`

```ts
type SessionSelectProps = {
  /** Whole-bundle index. Option list and seek targets both come from bySessionId. */
  index: EventIndex;
  /** The session the playhead is currently inside — engine-derived, not URL-derived. */
  currentSessionId: string;
  /** Seek the whole-bundle playhead to this globalIdx. */
  onSeek(globalIdx: number): void;
};
```

- `sessionIds = [...index.bySessionId.keys()]`. `bySessionId` is built from
  wall-sorted events, so key order is oldest → newest.
- Returns `null` when `sessionIds.length <= 1`, matching both existing `total > 1`
  guards. Single-session bundles render exactly as today.
- `<select value={currentSessionId}>`. Option label is the union of what the two bars
  show today: `Session {i+1} of {n} · {new Date(firstWall).toLocaleString()} · {count} events`.
  When a session's first event has no parseable `wall`, the timestamp segment is
  omitted (the local bar already does this at `ReplayView.tsx:136-137`).
- An `N / M` ordinal readout sits beside the select, derived from
  `sessionIds.indexOf(currentSessionId)`.
- `onChange` → `onSeek(index.bySessionId.get(target)![0].globalIdx)`. No `navigate`,
  no `setSearchParams`.
- Accessibility: `aria-label="Session"` on the select (the local bar's current
  treatment; the server bar's visible `<label htmlFor>` is dropped along with its
  row). The ordinal readout is `aria-hidden` — it duplicates the selected option text.
- Test ids `replay-session-switcher` (wrapper) and `replay-session-select` (the
  `<select>`) are carried over so existing selectors keep resolving.

### 2. Placement: leading element of the FileTabs row

`ReplayInner` renders `<SessionSelect>` as a `shrink-0` leading element of the
existing FileTabs row (`ReplayView.tsx:508`), with a divider, and wraps `<FileTabs>`
in a `min-w-0 flex-1` container so its `flex-wrap` tab list cannot squeeze the
select.

```
/local
┌────────────────────────────────────────────────┐
│ ‹ Back │ hw-bundle.zip                          │
├────────────────────────────────────────────────┤
│ [Session 2 of 3 · Jul 14 ▾] 2/3 │ hw.py  part2… │
├────────────────────────────────────────────────┤
│                  Monaco                        │

server Replay tab
┌────────────────────────────────────────────────┐
│ [Session 2 of 3 · Jul 14 ▾] 2/3 │ hw.py  part2… │
├────────────────────────────────────────────────┤
│                  Monaco                        │
```

No new row for either route. `/local` keeps its two rows; the server tab drops from
two to one and gains that height back for the editor.

Because it lives inside `ReplayInner` rather than behind `showHeader`, both routes
get the same control from the same code — resolving P3.

### 3. `ReplayInner` wiring

```tsx
<SessionSelect index={index} currentSessionId={state.sessionId} onSeek={handleJumpSeek} />
```

`handleJumpSeek` (`ReplayView.tsx:492-498`) pauses then seeks, which is what every
other jump control does — a session jump should land paused and browseable for the
same reason. No new handler.

`state.sessionId` updates on every `tick()`, so the select is a **live readout** that
changes during playback, not a static setting. That is the intent: it is the answer
to "which session am I in", and clicking it is the answer to "take me to session K".

### 4. `ReplayHeader` shrinks

Loses the `<select>`, the ordinal, `handleSessionChange`, the `sessionIds`/`total`/
`ordinal` memos, and its `index` and `sessionId` props. It keeps the Back button and
the source-filename label.

The session id is dropped from the header's label _and_ its `title` (today:
`Session: ${sessionId} · Bundle: ${sourceFilename}`, `ReplayView.tsx:147,155`). That
string names the **anchor**, so leaving it in the tooltip would reproduce P2 one
layer down. Session identity now has exactly one home: `SessionSelect`.

### 5. `views/submission/Replay.tsx` (server) loses its bar

Deleted:

- the `showSwitcher` bar (`:147-178`) and `handleSessionChange` (`:129-143`);
- the `?session=` reconcile effect (`:70-76`) and the `setSearchParams` binding.

Kept: `?session=` is still **read** as the entry anchor, still falling back to
`sessionIds[0]`, so the deep links `Timeline.tsx:29` emits continue to resolve. The
`!index.bySessionId.has(sessionId)` guard (`:112`) stays.

Dropping the write-back is deliberate: a `?session=` that the URL keeps asserting
while the playhead has moved elsewhere is the same lie as P2, in the address bar.
After this change `?event=` is the only position of record and
`:sessionId` / `?session=` are anchors that are never rewritten — which is what
§1.9 of the multi-session design specified.

### 6. Option list becomes index-derived on both routes

The server bar currently lists `summaryQuery.data.session_ids`; `SessionSelect` lists
`index.bySessionId` keys. A session present in the manifest but carrying zero events
therefore drops out of the list. It is unseekable by construction — there is no first
event to seek to — and `Replay.tsx:112` already renders an error state for exactly
that case, so this narrows the list to what the control can actually act on.

## Error handling

- **Single-session bundle** — `SessionSelect` renders `null`. No layout change from
  today.
- **Zero-event bundle** — `bySessionId` is empty, `sessionIds.length === 0`, renders
  `null`. Existing empty-state paths in `ReplayInner` apply unchanged.
- **`currentSessionId` not in the list** — cannot occur (it is read off an event in
  `index.ordered`), but `<select>` with an unmatched `value` would render blank
  rather than throw. The ordinal readout guards with `indexOf(...) >= 0` before
  rendering, matching the existing `ordinal > 0` check at `ReplayView.tsx:160`.
- **Unparseable `wall` on a session's first event** — timestamp segment omitted from
  that option's label; the ordinal and event count still render.
- **Stale `?session=` / `:sessionId` after seeking away** — harmless. On a reload
  `?event=` wins in the mount effect (`ReplayView.tsx:391-399`), so position is
  preserved and the anchor is ignored.

## Testing

New — `SessionSelect.test.tsx`:

- renders `null` for a single-session bundle and for an empty index;
- one option per session, label carrying ordinal, timestamp, and event count;
- label omits the timestamp when the first event's `wall` is unparseable;
- `value` tracks the `currentSessionId` prop, not any URL;
- `onChange` calls `onSeek` with the target session's **first `globalIdx`**.

Rewritten — `ReplayView.test.tsx`:

- `:430` "changing the switcher navigates to the other session" becomes **"changing
  the switcher moves the playhead"**: assert the transport slider's `aria-valuenow`
  and the reconstructed Monaco content, not the select's own value. This is the
  scratch test that reproduced P1, promoted to a regression test — it fails before
  the fix.
- `:422` "reflects the active session as the selected option" is rewritten from
  entry-anchor semantics to playhead semantics: seek across a seam via the transport
  and assert the select's value follows, with no URL change involved.

Updated — `views/submission/Replay.test.tsx`:

- the server tab no longer renders its own switcher bar; the select present in the
  tree is the one `ReplayInner` owns, and changing it seeks;
- mounting without `?session=` no longer writes it back into the URL.

Per CLAUDE.md, no existing assertion is weakened. The two rewritten `ReplayView`
tests encode behavior this design intentionally changes, and they are rewritten to
assert the new behavior explicitly rather than relaxed.

## Non-goals

- No previous-seam jump control. `findNextSeam` stays forward-only; bidirectional
  seam movement was the alternative to this design, not part of it.
- No session ribbon / proportional timeline strip.
- No `?session=` write-back, and no new URL parameters.
- No changes to `bundle-clock.ts`, seam detection, seam rendering, or the engine.
- No changes outside `packages/analyzer`. No new dependencies.
