# Clickable dashboard flag chips → jump to the flag

**Date:** 2026-07-23
**Status:** Approved, ready for implementation plan

## Problem

Course staff asked: _"is it possible to press on the flag of a student in the main
page and get transferred to the exact place where that flag happened?"_

On the cohort dashboard, the per-submission `top_flags` chips (the named heuristic
chips, up to 3 per row) are inert `<span>`s. There is no way to click a flag and land
on its context. The deep-linking machinery to reach a flag's supporting events already
exists **inside** a submission (Overview flag drawer → "Raw timeline" / "▶ Replay"), but
the dashboard chips don't route into it.

## Decision

Clicking a `top_flags` chip navigates into that submission's **Overview tab with the
matching flag's detail drawer auto-opened** — not straight to a raw timeline event. This
keeps the flag's explanation (description + supporting events) in view, and it needs
**no API/schema change**: the cohort payload already carries `heuristic_id` per chip,
which is enough to identify the flag once we're inside the submission.

Rejected alternative: jumping straight to the first supporting event in the Timeline.
That drops staff at an unexplained raw event and would require adding a first-instance
`seq` to the cohort API's `top_flags` payload (it currently carries only
`heuristic_id` + `severity`).

## Scope

**In scope**

- `top_flags` heuristic chips in `packages/analyzer/src/views/cohort/CohortTable.tsx`
  (the `top_flags` column, ~lines 246–265) become links.
- `packages/analyzer/src/views/submission/Overview.tsx` reads a new `?flag=` search
  param and auto-opens the matching flag drawer.

**Out of scope (unchanged)**

- The severity count badges (`flag_counts`: high/med/low/info numbers) stay inert.
- `StudentRollupTable.tsx` — it renders `flag_counts` + a `worst_submission` jump
  button, not `top_flags`, so it needs no change.
- No changes to `packages/shared` API schemas or the server.

## Behavior

### Dashboard chip → link

Each `top_flags` chip becomes a `<Link>` (same `RowLink`/router pattern already used
for the student cell and the `worst_submission` button) to:

```
${basePath}/sub/${submissionId}?tab=overview&flag=${heuristic_id}
```

- `basePath` comes from `useActiveSemester()` (already used at CohortTable.tsx:193).
- Because it's a real link, middle-click / cmd-click opens a new tab for free.
- The chip gains a hover/focus affordance (cursor + ring/underline) so it reads as
  interactive. The student-cell row link is a separate table cell, so there is no
  nested-anchor problem.

### Overview `?flag=` param → auto-open drawer

`Overview.tsx` reads `?flag=<heuristic_id>`. On mount and whenever the param changes:

1. Find the flag(s) whose `heuristic_id` matches the param.
2. If several match, open the **highest-severity** one (tie → first in the existing
   sort order). _(User-confirmed default; not "earliest by time".)_
3. Trigger the same lazy event-index load that a manual drawer-open triggers
   (`needsIndex`), then open that flag's `HeuristicDetailDrawer` — behaviourally
   identical to the staff member having clicked the flag row themselves. Supporting
   events and their "Raw timeline" / "▶ Replay" buttons work as they do today.
4. If no flag matches (stale link, flag no longer present), Overview renders normally
   with no drawer open. No error, no toast — graceful no-op.

## Testing

- `CohortTable` test: a `top_flags` chip renders as a link with
  `to === ".../sub/<id>?tab=overview&flag=<heuristic_id>"`.
- `Overview` test:
  - `?flag=<id>` auto-opens the drawer for the matching flag.
  - collision (two flags, same heuristic, different severity) opens the
    highest-severity one.
  - unmatched `?flag=` renders with no drawer and no error.

## Files touched

- `packages/analyzer/src/views/cohort/CohortTable.tsx` (+ co-located test)
- `packages/analyzer/src/views/submission/Overview.tsx` (+ co-located test)

Small diff, ~2 source files. No architecture-page impact (no event type, check,
heuristic, route, pipeline, table, or format change) — the `/architecture` page stays
correct as-is.
