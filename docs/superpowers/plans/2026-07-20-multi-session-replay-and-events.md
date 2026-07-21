# Multi-session Replay + Unified Events Page — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the analyzer's Replay view span the whole submission bundle instead of one recorder session, and give the server-backed events page the same full-featured event browser the `/local` route already has.

**Architecture:** The replay engine is re-pointed from `index.bySessionId.get(id)` to `index.ordered` (which is already a single chronological cross-session stream where `globalIdx === array position`). Playback timing moves from the per-session `t` field to a derived, analyzer-local `bundleT` array that accumulates `t` within a session and inserts a clamped ~5 s gap at each session seam. Separately, the local `TimelineView` body is extracted into a shared `TimelineInner` that both the `/local` route and the server-backed Timeline tab mount — the server tab switching from a 500-row-capped `useEvents()` list to the exhaustive `useFullEventIndex()` the Replay tab already uses.

**Tech Stack:** TypeScript (strict), React 18, Vite, Vitest + React Testing Library, `@tanstack/react-virtual`, `@tanstack/react-query`, react-router-dom.

**Spec:** `docs/superpowers/specs/2026-07-20-multi-session-replay-and-events-design.md`

## Global Constraints

- **Analyzer-only.** No changes to `packages/log-core`, `packages/analysis-core`, `packages/shared`, `packages/server`, or `packages/recorder`. If a task appears to need one, stop and ask.
- **No new dependencies.** Every library used already exists in `packages/analyzer/package.json`.
- **`@testing-library/user-event` is NOT available** and must not be added. Use `fireEvent` from `@testing-library/react`. Consequence: Radix dropdown _contents_ (kind/file/session filter menus) cannot be opened in tests, because Radix opens on pointer events `fireEvent.click` does not emit. Assert on rendered output instead of menu internals — e.g. verify cross-session coverage via the per-row `session-chip-<globalIdx>` elements rather than by opening the session filter.
- **TypeScript strict mode.** No `any` except at FFI boundaries with an explaining comment. `unknown` over `any` for untyped input.
- **No silent constraint softening.** If an existing test fails, do not weaken the assertion. Either the implementation is wrong, or the test encodes behavior this plan intentionally changes — in which case rewrite the test to encode the _new_ behavior explicitly and say so in the commit message.
- **Tests are deterministic.** No `Date.now()` or `Math.random()` in assertions.
- **Commits:** `git commit --no-gpg-sign`, conventional-commit prefixes, **no `Co-Authored-By` trailer**. Always stage with an explicit pathspec — the repo frequently has unrelated uncommitted work in the tree. Never `git add -A` or `git add .`.
- **Verification before "done":** a task is complete only when `npm run test --workspace=packages/analyzer`, `npm run typecheck --workspace=packages/analyzer`, and `npm run lint --workspace=packages/analyzer` all pass.
- **Seam clock constants:** `SEAM_MAX_GAP_MS = 5_000`, `SEAM_FLOOR_MS = 1_000`.

## File Structure

**Phase 1 — Events page unification**

| File                                            | Responsibility                                                                                     |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `src/views/timeline/EventList.tsx` (modify)     | Drop the hardcoded `/local/replay/...` navigation; accept an `onJumpToReplay` callback.            |
| `src/views/timeline/TimelineInner.tsx` (create) | Route-agnostic events browser: filter bar + virtualized list + detail pane. Takes an `EventIndex`. |
| `src/views/timeline/TimelineView.tsx` (modify)  | Thin `/local` wrapper: `useBundle()` → `TimelineInner`.                                            |
| `src/views/submission/Timeline.tsx` (rewrite)   | Thin server wrapper: `useFullEventIndex()` → `TimelineInner`.                                      |

**Phase 2 — Bundle clock + whole-bundle engine**

| File                                           | Responsibility                                                                   |
| ---------------------------------------------- | -------------------------------------------------------------------------------- |
| `src/views/replay/bundle-clock.ts` (create)    | Pure derivation of `bundleT` + `seams` from `index.ordered`. No React.           |
| `src/views/replay/engine-core.ts` (modify)     | Whole-bundle event stream; `bundleT`-driven playback.                            |
| `src/views/replay/useReplayEngine.ts` (modify) | Drop the `sessionId` argument.                                                   |
| `src/views/replay/TransportBar.tsx` (modify)   | Whole-bundle scrubbing + seam ticks.                                             |
| `src/views/replay/ReplayView.tsx` (modify)     | `:sessionId` becomes an entry anchor, not a scope.                               |
| `src/views/submission/Replay.tsx` (modify)     | `?session=` becomes an entry anchor; the `<select>` seeks instead of remounting. |

**Phase 3 — Seam + file-tab UI**

| File                                           | Responsibility                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------- |
| `src/views/replay/file-recency.ts` (create)    | Pure last-edited / dimming computation for the tab strip.           |
| `src/views/replay/FileTabs.tsx` (modify)       | All-bundle tabs, last-edited badge, dimming, selection persistence. |
| `src/views/replay/EventSidebar.tsx` (modify)   | Whole-bundle rows with seam dividers, variable row heights.         |
| `src/views/replay/jump-predicates.ts` (modify) | `findNextSeam` / `countRemainingSeams`.                             |
| `src/views/replay/JumpControls.tsx` (modify)   | Seam jump button.                                                   |

---

## Phase 1 — Events page unification

Independent of the engine work. Land and review this before starting Phase 2.

### Task 1: Make EventList route-agnostic

`EventList.tsx:233` hardcodes `void navigate(\`/local/replay/${event.sessionId}?event=${event.globalIdx}\`)`. The server-backed Timeline tab needs `?tab=replay&event=…` instead, so the navigation target must come from the parent.

**Files:**

- Modify: `packages/analyzer/src/views/timeline/EventList.tsx` (props type ~line 310, `EventRow` ~lines 221-234)
- Test: `packages/analyzer/src/views/timeline/EventList.test.tsx`

**Interfaces:**

- Produces: `EventListProps.onJumpToReplay?: (event: IndexedEvent) => void` — threaded from `EventList` down to each `EventRow`. When omitted, the replay button is not rendered.

- [ ] **Step 1: Write the failing test**

Add to `packages/analyzer/src/views/timeline/EventList.test.tsx`:

```tsx
it('calls onJumpToReplay with the event when the replay button is clicked', () => {
  const onJumpToReplay = vi.fn();
  const event = makeEvent({ globalIdx: 3, seq: 3, kind: 'doc.change' });

  render(
    <MemoryRouter>
      <EventList
        events={[event]}
        onSelect={() => {}}
        selectedKey={null}
        scrollToKey={null}
        onJumpToReplay={onJumpToReplay}
      />
    </MemoryRouter>,
  );

  fireEvent.click(screen.getByTestId('replay-btn-3'));

  expect(onJumpToReplay).toHaveBeenCalledTimes(1);
  expect(onJumpToReplay).toHaveBeenCalledWith(event);
});

it('does not render the replay button when onJumpToReplay is omitted', () => {
  render(
    <MemoryRouter>
      <EventList
        events={[makeEvent({ globalIdx: 3, seq: 3, kind: 'doc.change' })]}
        onSelect={() => {}}
        selectedKey={null}
        scrollToKey={null}
      />
    </MemoryRouter>,
  );

  expect(screen.queryByTestId('jump-to-replay-3')).toBeNull();
});
```

Use `fireEvent` — `@testing-library/user-event` is not a dependency. The replay button's existing testid is `replay-btn-<globalIdx>`; keep it rather than renaming production code.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test --workspace=packages/analyzer -- src/views/timeline/EventList.test.tsx`
Expected: FAIL — `onJumpToReplay` is not a recognized prop and `jump-to-replay-3` is not found.

- [ ] **Step 3: Thread the callback through**

In `EventList.tsx`, extend the row props and use the callback instead of `useNavigate`:

```tsx
interface EventRowProps {
  event: IndexedEvent;
  isSelected: boolean;
  onClick: () => void;
  style: React.CSSProperties;
  onJumpToReplay?: ((event: IndexedEvent) => void) | undefined;
}

function EventRow({ event, isSelected, onClick, style, onJumpToReplay }: EventRowProps) {
  const summary = payloadSummary(event);
  // ... filePart unchanged ...

  const handleReplayClick = (e: React.MouseEvent) => {
    // Prevent the row's onClick (select event) from also firing.
    e.stopPropagation();
    onJumpToReplay?.(event);
  };
```

Remove the now-unused `useNavigate` import and its call. Guard the replay button's JSX with `{onJumpToReplay && ( … )}` and give it `data-testid={\`jump-to-replay-${event.globalIdx}\`}` — check whether the existing button already has a testid and keep the existing one if so, updating the test to match rather than renaming the production testid.

Add `onJumpToReplay` to the `EventListProps` type and pass it down where `EventRow` is rendered (~line 381).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test --workspace=packages/analyzer -- src/views/timeline/EventList.test.tsx`
Expected: PASS, including all pre-existing tests in the file.

- [ ] **Step 5: Restore local jump behavior in TimelineView**

`TimelineView.tsx` must now supply the callback so `/local` behaves exactly as before. Add to `TimelineView`:

```tsx
const navigate = useNavigate();

const handleJumpToReplay = useCallback(
  (event: IndexedEvent) => {
    void navigate(`/local/replay/${event.sessionId}?event=${event.globalIdx}`);
  },
  [navigate],
);
```

and pass `onJumpToReplay={handleJumpToReplay}` to `<EventList>`. Add `useNavigate` to the `react-router-dom` import.

- [ ] **Step 6: Verify the whole suite**

Run: `npm run test --workspace=packages/analyzer && npm run typecheck --workspace=packages/analyzer && npm run lint --workspace=packages/analyzer`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add packages/analyzer/src/views/timeline/EventList.tsx \
        packages/analyzer/src/views/timeline/EventList.test.tsx \
        packages/analyzer/src/views/timeline/TimelineView.tsx
git commit --no-gpg-sign -m "refactor(analyzer): make EventList replay navigation caller-supplied

EventList hardcoded /local/replay/... so it could not be reused by the
server-backed Timeline tab, which needs ?tab=replay&event=. The target now
comes from an onJumpToReplay prop; TimelineView supplies the /local target."
```

### Task 2: Extract TimelineInner

**Files:**

- Create: `packages/analyzer/src/views/timeline/TimelineInner.tsx`
- Modify: `packages/analyzer/src/views/timeline/TimelineView.tsx`
- Test: `packages/analyzer/src/views/timeline/TimelineInner.test.tsx`

**Interfaces:**

- Consumes: `EventListProps.onJumpToReplay` from Task 1.
- Produces:
  ```tsx
  type TimelineInnerProps = {
    index: EventIndex;
    onJumpToReplay?: ((event: IndexedEvent) => void) | undefined;
  };
  export function TimelineInner(props: TimelineInnerProps): JSX.Element;
  ```

`TimelineInner` owns everything `TimelineView` currently does _except_ reading `useBundle()`: filter state, derived `availableKinds` / `availableFiles` / `availableSessions`, `useFilteredEvents`, the `?seq=sessionId:42` deep-link effect, selection state, and the list+detail grid. The deep-link effect stays inside `TimelineInner` — both routes are search-param based, so it needs no per-route variation.

- [ ] **Step 1: Write the failing test**

Create `packages/analyzer/src/views/timeline/TimelineInner.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TimelineInner } from './TimelineInner.js';
import { buildIndex } from '@provenance/analysis-core/index/build-index.js';
import { buildTestBundle } from '@provenance/analysis-core/test-support/build-test-bundle.js';

// NOTE: read packages/analysis-core/src/test-support/build-test-bundle.ts first
// and use its real exported signature. If it cannot produce a two-session
// bundle directly, construct the EventIndex via buildIndexFromEventRows with
// hand-written rows instead — do not invent an API.

describe('TimelineInner', () => {
  it('renders one row per event in the index', () => {
    const index = /* two-session index, 5 events total */;
    render(
      <MemoryRouter>
        <TimelineInner index={index} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('event-count-label')).toHaveTextContent('5 events');
  });

  it('invokes onJumpToReplay with the clicked event', () => {
    const onJumpToReplay = vi.fn();
    const index = /* same index */;
    render(
      <MemoryRouter>
        <TimelineInner index={index} onJumpToReplay={onJumpToReplay} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId('replay-btn-0'));
    expect(onJumpToReplay).toHaveBeenCalledWith(index.ordered[0]);
  });

  it('lists every session from the index in the session filter', () => {
    const index = /* two-session index */;
    render(
      <MemoryRouter>
        <TimelineInner index={index} />
      </MemoryRouter>,
    );
    // Assert both session ids are offered. Read FilterBar.tsx:275-302 for the
    // exact trigger testid and option rendering before writing this assertion.
  });
});
```

Fill the `/* … */` placeholders with a real two-session index before running — the plan cannot pre-write them without the `build-test-bundle` signature. Look at `packages/analyzer/src/views/overview/test-fixtures.ts` for the fixture style this codebase already uses.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test --workspace=packages/analyzer -- src/views/timeline/TimelineInner.test.tsx`
Expected: FAIL — module `./TimelineInner.js` not found.

- [ ] **Step 3: Create TimelineInner**

Move the body of `TimelineView` (currently `TimelineView.tsx:26-139`) into the new file verbatim, with three changes: it takes `index` as a prop instead of calling `useBundle()`; it takes and forwards `onJumpToReplay`; and it keeps `data-testid="timeline-view"` on the root so existing `/local` tests continue to pass.

```tsx
/**
 * TimelineInner — route-agnostic events browser: filter bar + virtualized
 * event list + detail pane.
 *
 * Mounted by two routes against two different sources of the same EventIndex:
 *   - /local            → BundleContext (parsed in-browser from a .zip)
 *   - ?tab=timeline     → useFullEventIndex (paged from the server API)
 *
 * Deep-link: ?seq=sessionId:42 selects + scrolls to the matching event.
 * Both routes are search-param based, so that handling lives here.
 */

import { useState, useMemo, useCallback, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { EventIndex, IndexedEvent } from '@provenance/analysis-core/index/event-index.js';
import type { EventKind } from '@provenance/log-core';
import { DEFAULT_FILTERS, useFilteredEvents, type TimelineFilters } from './useFilteredEvents.js';
import { FilterBar } from './FilterBar.js';
import { EventList } from './EventList.js';
import { EventDetail } from './EventDetail.js';

type TimelineInnerProps = {
  index: EventIndex;
  onJumpToReplay?: ((event: IndexedEvent) => void) | undefined;
};

export function TimelineInner({ index, onJumpToReplay }: TimelineInnerProps) {
  const [searchParams] = useSearchParams();

  const [filters, setFilters] = useState<TimelineFilters>(DEFAULT_FILTERS);
  const [selectedEvent, setSelectedEvent] = useState<IndexedEvent | null>(null);
  const [scrollToKey, setScrollToKey] = useState<string | null>(null);

  const allEvents = index.ordered;

  // ... availableKinds / availableFiles / availableSessions / filteredEvents /
  // the ?seq= effect / handleSelect / handleNavigate / selectedKey: copied
  // verbatim from TimelineView.tsx:37-99 ...

  return (
    // ... JSX copied verbatim from TimelineView.tsx:101-138, with
    // onJumpToReplay={onJumpToReplay} added to <EventList> ...
  );
}
```

- [ ] **Step 4: Reduce TimelineView to a wrapper**

Replace the whole body of `TimelineView.tsx` with:

```tsx
/**
 * TimelineView — /local route wrapper around TimelineInner.
 *
 * Supplies the EventIndex from BundleContext and the /local replay target.
 * All behavior lives in TimelineInner, which the server-backed Timeline tab
 * mounts against an API-derived index.
 *
 * PRD §7.2 ("Raw timeline").
 */

import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useBundle } from '../../context/BundleContext.js';
import type { IndexedEvent } from '@provenance/analysis-core/index/event-index.js';
import { TimelineInner } from './TimelineInner.js';

export function TimelineView() {
  const { index } = useBundle();
  const navigate = useNavigate();

  const handleJumpToReplay = useCallback(
    (event: IndexedEvent) => {
      void navigate(`/local/replay/${event.sessionId}?event=${event.globalIdx}`);
    },
    [navigate],
  );

  if (index === null) return null;

  return <TimelineInner index={index} onJumpToReplay={handleJumpToReplay} />;
}
```

Check what `TimelineView` currently renders when `index === null` (today it falls through to `index?.ordered ?? []`, rendering an empty list). If any existing test asserts on that empty state, preserve it rather than returning `null`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test --workspace=packages/analyzer -- src/views/timeline/`
Expected: PASS — both the new `TimelineInner.test.tsx` and every pre-existing timeline test.

- [ ] **Step 6: Commit**

```bash
git add packages/analyzer/src/views/timeline/TimelineInner.tsx \
        packages/analyzer/src/views/timeline/TimelineInner.test.tsx \
        packages/analyzer/src/views/timeline/TimelineView.tsx
git commit --no-gpg-sign -m "refactor(analyzer): extract TimelineInner from TimelineView

TimelineView read the EventIndex straight from BundleContext, so the whole
events browser was unusable outside /local. TimelineInner takes the index as
a prop; TimelineView becomes a thin wrapper. No behavior change."
```

### Task 3: Rewire the server-backed Timeline tab

This is the task that fixes "it only shows the first certain number".

**Files:**

- Rewrite: `packages/analyzer/src/views/submission/Timeline.tsx`
- Test: `packages/analyzer/src/views/submission/Timeline.test.tsx`

**Interfaces:**

- Consumes: `TimelineInner` (Task 2); `useFullEventIndex(submissionId)` from `src/data/useFullEventIndex.ts`, returning `UseQueryResult<EventIndex>`.

What is deleted: the `events.slice(0, 500)` cap (line 84), the ad-hoc `eventSummary` and `formatWall` helpers, the bespoke row markup, and the `COMMON_KINDS` array — which contains `doc.paste`, a kind that does not exist (the real kind is `paste`), so that filter button has never matched anything. `FilterBar` derives its kind list from the index, so the hardcoded list is not replaced by anything.

- [ ] **Step 1: Write the failing tests**

Read the existing `Timeline.test.tsx` first — it tests the old bespoke list and will need rewriting, not extending. Per the global constraints, rewrite it to encode the new behavior; do not delete assertions to make things pass.

```tsx
it('renders every event, not just the first 500', async () => {
  // Mock useFullEventIndex to resolve an index with 600 events.
  render(<Timeline />, { wrapper });
  expect(await screen.findByTestId('event-count-label')).toHaveTextContent('600 events');
});

it('renders an error state when the event ceiling is exceeded', async () => {
  // Mock useFullEventIndex to reject with the MAX_EVENTS error.
  render(<Timeline />, { wrapper });
  expect(await screen.findByTestId('timeline-error')).toBeInTheDocument();
});

it('navigates to the replay tab when a row jump button is clicked', async () => {
  // Assert the search params become tab=replay&event=<globalIdx>.
});
```

Follow the mocking style already used in `packages/analyzer/src/views/submission/Replay.test.tsx` — it mocks the same `useFullEventIndex` hook, so copy that setup rather than inventing one.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test --workspace=packages/analyzer -- src/views/submission/Timeline.test.tsx`
Expected: FAIL — the component still caps at 500 and has no `event-count-label`.

- [ ] **Step 3: Rewrite Timeline.tsx**

```tsx
/**
 * Timeline tab — the full events browser, backed by the server API.
 *
 * Mounts the same TimelineInner the /local route uses, against an EventIndex
 * built by paging GET /submissions/:id/events to exhaustion. This mirrors how
 * the Replay tab (views/submission/Replay.tsx) already sources its index.
 *
 * Previously this was a bespoke list capped at 500 rows with no detail pane,
 * no jump-to-replay, and no session filter.
 */

import { useCallback } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import type { IndexedEvent } from '@provenance/analysis-core/index/event-index.js';
import { useFullEventIndex } from '../../data/useFullEventIndex.js';
import { TimelineInner } from '../timeline/TimelineInner.js';
import { StatusRegion } from '../../components/a11y/StatusRegion.js';
import { ErrorRegion } from '../../components/a11y/ErrorRegion.js';

export function Timeline() {
  const { id: submissionId = '' } = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const indexQuery = useFullEventIndex(submissionId);

  const handleJumpToReplay = useCallback(
    (event: IndexedEvent) => {
      const next = new URLSearchParams(searchParams);
      next.set('tab', 'replay');
      next.set('session', event.sessionId);
      next.set('event', String(event.globalIdx));
      setSearchParams(next);
    },
    [searchParams, setSearchParams],
  );

  if (indexQuery.isLoading) {
    return (
      <StatusRegion className="p-6 text-center text-sm text-gray-600">
        <div data-testid="timeline-loading">Loading events…</div>
      </StatusRegion>
    );
  }

  if (indexQuery.isError) {
    return (
      <ErrorRegion className="p-6 text-sm text-red-600">
        <div data-testid="timeline-error">
          Failed to load events. {indexQuery.error instanceof Error ? indexQuery.error.message : ''}
        </div>
      </ErrorRegion>
    );
  }

  const index = indexQuery.data;
  if (index === undefined || index.ordered.length === 0) {
    return (
      <div className="p-6 text-center text-sm text-gray-600" data-testid="timeline-empty">
        No events in this submission.
      </div>
    );
  }

  return <TimelineInner index={index} onJumpToReplay={handleJumpToReplay} />;
}
```

Confirm the route param name (`id` vs something else) against `App.tsx` and against how `views/submission/Replay.tsx` reads it — use whatever that file uses.

The error branch is a real improvement, not incidental: `useFullEventIndex` throws above `MAX_EVENTS` (200k), and the old component would have silently shown 500 rows with no indication anything was missing.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test --workspace=packages/analyzer -- src/views/submission/Timeline.test.tsx`
Expected: PASS.

- [ ] **Step 5: Verify the whole suite**

Run: `npm run test --workspace=packages/analyzer && npm run typecheck --workspace=packages/analyzer && npm run lint --workspace=packages/analyzer`
Expected: all pass. `SubmissionShell.test.tsx` may assert on the old Timeline markup — if so, update it to the new testids.

- [ ] **Step 6: Commit**

```bash
git add packages/analyzer/src/views/submission/Timeline.tsx \
        packages/analyzer/src/views/submission/Timeline.test.tsx
git commit --no-gpg-sign -m "feat(analyzer): give the server events tab the full event browser

The Timeline tab was a stub: events.slice(0, 500) over a limit=2000 query,
no detail pane, no jump-to-replay, no session filter, and a kind filter
listing doc.paste — a kind that does not exist, so it never matched.

It now mounts TimelineInner against useFullEventIndex, the same exhaustive
paging the Replay tab already used, and surfaces the 200k ceiling as a
visible error instead of silently truncating."
```

**PHASE 1 CHECKPOINT** — stop for review before continuing.

---

## Phase 2 — Bundle clock + whole-bundle engine

### Task 4: bundle-clock.ts

**Files:**

- Create: `packages/analyzer/src/views/replay/bundle-clock.ts`
- Test: `packages/analyzer/src/views/replay/bundle-clock.test.ts`

**Interfaces:**

- Produces:

  ```ts
  export const SEAM_MAX_GAP_MS = 5_000;
  export const SEAM_FLOOR_MS = 1_000;

  export type Seam = {
    atGlobalIdx: number; // globalIdx of the FIRST event of the next session
    prevSessionId: string;
    nextSessionId: string;
    realGapMs: number; // may be negative under clock skew
    collapsedGapMs: number; // always within [SEAM_FLOOR_MS, SEAM_MAX_GAP_MS]
  };

  export type BundleClock = {
    bundleT: Float64Array; // indexed by globalIdx; non-decreasing
    seams: Seam[];
  };

  export function buildBundleClock(
    ordered: readonly IndexedEvent[],
    opts?: { maxSeamGapMs?: number },
  ): BundleClock;
  ```

Semantics: `bundleT[0] = 0`. For `i > 0`, if `ordered[i].sessionId === ordered[i-1].sessionId` then `bundleT[i] = bundleT[i-1] + max(0, t[i] - t[i-1])`; otherwise `bundleT[i] = bundleT[i-1] + collapsedGapMs` and a `Seam` is recorded at `i`. `collapsedGapMs = clamp(realGapMs, SEAM_FLOOR_MS, maxSeamGapMs)`, and any non-finite or negative `realGapMs` yields `SEAM_FLOOR_MS`.

- [ ] **Step 1: Write the failing tests**

Create `packages/analyzer/src/views/replay/bundle-clock.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildBundleClock, SEAM_FLOOR_MS, SEAM_MAX_GAP_MS } from './bundle-clock.js';
import type { IndexedEvent } from '@provenance/analysis-core/index/event-index.js';

function ev(globalIdx: number, sessionId: string, t: number, wall: string): IndexedEvent {
  return { globalIdx, sessionId, seq: globalIdx, t, wall, kind: 'doc.change', payload: null };
}

describe('buildBundleClock', () => {
  it('returns an empty clock for no events', () => {
    const clock = buildBundleClock([]);
    expect(clock.bundleT.length).toBe(0);
    expect(clock.seams).toEqual([]);
  });

  it('accumulates t deltas within a single session and reports no seams', () => {
    const clock = buildBundleClock([
      ev(0, 'a', 0, '2026-01-01T00:00:00.000Z'),
      ev(1, 'a', 100, '2026-01-01T00:00:00.100Z'),
      ev(2, 'a', 450, '2026-01-01T00:00:00.450Z'),
    ]);
    expect(Array.from(clock.bundleT)).toEqual([0, 100, 450]);
    expect(clock.seams).toEqual([]);
  });

  it('collapses a long inter-session gap to maxSeamGapMs', () => {
    const clock = buildBundleClock([
      ev(0, 'a', 0, '2026-01-01T00:00:00.000Z'),
      ev(1, 'a', 100, '2026-01-01T00:00:00.100Z'),
      // next session starts 4 hours later, and its t resets to 0
      ev(2, 'b', 0, '2026-01-01T04:00:00.100Z'),
      ev(3, 'b', 50, '2026-01-01T04:00:00.150Z'),
    ]);
    expect(Array.from(clock.bundleT)).toEqual([
      0,
      100,
      100 + SEAM_MAX_GAP_MS,
      100 + SEAM_MAX_GAP_MS + 50,
    ]);
    expect(clock.seams).toHaveLength(1);
    expect(clock.seams[0]).toMatchObject({
      atGlobalIdx: 2,
      prevSessionId: 'a',
      nextSessionId: 'b',
      realGapMs: 4 * 60 * 60 * 1000,
      collapsedGapMs: SEAM_MAX_GAP_MS,
    });
  });

  it('raises a sub-floor gap to SEAM_FLOOR_MS', () => {
    const clock = buildBundleClock([
      ev(0, 'a', 0, '2026-01-01T00:00:00.000Z'),
      ev(1, 'b', 0, '2026-01-01T00:00:00.200Z'), // 200ms real gap
    ]);
    expect(clock.seams[0]!.realGapMs).toBe(200);
    expect(clock.seams[0]!.collapsedGapMs).toBe(SEAM_FLOOR_MS);
    expect(Array.from(clock.bundleT)).toEqual([0, SEAM_FLOOR_MS]);
  });

  it('clamps a negative gap (clock skew) to SEAM_FLOOR_MS and stays monotonic', () => {
    const clock = buildBundleClock([
      ev(0, 'a', 0, '2026-01-01T05:00:00.000Z'),
      ev(1, 'b', 0, '2026-01-01T04:00:00.000Z'), // next session's wall is EARLIER
    ]);
    expect(clock.seams[0]!.realGapMs).toBeLessThan(0);
    expect(clock.seams[0]!.collapsedGapMs).toBe(SEAM_FLOOR_MS);
    expect(Array.from(clock.bundleT)).toEqual([0, SEAM_FLOOR_MS]);
  });

  it('clamps an unparseable wall to SEAM_FLOOR_MS', () => {
    const clock = buildBundleClock([ev(0, 'a', 0, 'not-a-date'), ev(1, 'b', 0, 'also-not-a-date')]);
    expect(clock.seams[0]!.collapsedGapMs).toBe(SEAM_FLOOR_MS);
    expect(Array.from(clock.bundleT)).toEqual([0, SEAM_FLOOR_MS]);
  });

  it('never decreases even when t goes backwards within a session', () => {
    const clock = buildBundleClock([
      ev(0, 'a', 0, '2026-01-01T00:00:00.000Z'),
      ev(1, 'a', 500, '2026-01-01T00:00:00.500Z'),
      ev(2, 'a', 200, '2026-01-01T00:00:00.700Z'), // t regressed
    ]);
    const arr = Array.from(clock.bundleT);
    expect(arr).toEqual([0, 500, 500]);
    for (let i = 1; i < arr.length; i++) expect(arr[i]!).toBeGreaterThanOrEqual(arr[i - 1]!);
  });

  it('honors a maxSeamGapMs override', () => {
    const clock = buildBundleClock(
      [ev(0, 'a', 0, '2026-01-01T00:00:00.000Z'), ev(1, 'b', 0, '2026-01-01T10:00:00.000Z')],
      { maxSeamGapMs: 2_000 },
    );
    expect(clock.seams[0]!.collapsedGapMs).toBe(2_000);
  });

  it('records one seam per session transition across three sessions', () => {
    const clock = buildBundleClock([
      ev(0, 'a', 0, '2026-01-01T00:00:00.000Z'),
      ev(1, 'b', 0, '2026-01-01T01:00:00.000Z'),
      ev(2, 'c', 0, '2026-01-01T02:00:00.000Z'),
    ]);
    expect(clock.seams.map((s) => s.atGlobalIdx)).toEqual([1, 2]);
    expect(clock.seams.map((s) => s.nextSessionId)).toEqual(['b', 'c']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test --workspace=packages/analyzer -- src/views/replay/bundle-clock.test.ts`
Expected: FAIL — module `./bundle-clock.js` not found.

- [ ] **Step 3: Implement bundle-clock.ts**

```ts
/**
 * bundle-clock — derives a whole-bundle playback clock from the cross-session
 * event stream.
 *
 * WHY THIS EXISTS
 * Each event's `t` is milliseconds since ITS OWN session's start, so `t` resets
 * to 0 at every session boundary. The replay engine advances a virtual clock and
 * applies events whose time falls in the window; feeding it raw `t` across a
 * concatenated multi-session stream would rewind time at each boundary.
 *
 * `bundleT[globalIdx]` is a monotonically non-decreasing timeline for the whole
 * bundle:
 *   - within a session, it accumulates `t` deltas, so within-session playback
 *     timing is identical to the pre-whole-bundle engine;
 *   - across a seam, it inserts a CLAMPED gap, so an overnight break plays as a
 *     brief pause rather than an unwatchable dead stop. The real duration is not
 *     lost — it is carried on the Seam and rendered in the UI.
 *
 * This lives in the analyzer, not analysis-core, on purpose: analysis-core is
 * consumed by the server and `IndexedEvent` is a shared shape. This is a
 * playback concern with no analysis meaning.
 */

import type { IndexedEvent } from '@provenance/analysis-core/index/event-index.js';

/** Longest pause an inter-session gap may render as, in ms. */
export const SEAM_MAX_GAP_MS = 5_000;

/**
 * Shortest pause an inter-session gap may render as, in ms. Also the fallback
 * for gaps that are negative, NaN, or unparseable — cross-machine clock skew is
 * a real condition here (see the clock_jumps heuristic), and `bundleT` must stay
 * non-decreasing regardless of what the wall clocks say.
 */
export const SEAM_FLOOR_MS = 1_000;

export type Seam = {
  /** globalIdx of the FIRST event of the next session. */
  atGlobalIdx: number;
  prevSessionId: string;
  nextSessionId: string;
  /** True wall-clock gap in ms. May be negative or NaN under clock skew. */
  realGapMs: number;
  /** Gap as rendered during playback. Always in [SEAM_FLOOR_MS, maxSeamGapMs]. */
  collapsedGapMs: number;
};

export type BundleClock = {
  /** Indexed by globalIdx. Guaranteed non-decreasing. */
  bundleT: Float64Array;
  seams: Seam[];
};

function parseWallMs(wall: string): number {
  const ms = Date.parse(wall);
  return Number.isFinite(ms) ? ms : NaN;
}

export function buildBundleClock(
  ordered: readonly IndexedEvent[],
  opts?: { maxSeamGapMs?: number },
): BundleClock {
  const maxSeamGapMs = opts?.maxSeamGapMs ?? SEAM_MAX_GAP_MS;
  const bundleT = new Float64Array(ordered.length);
  const seams: Seam[] = [];

  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1]!;
    const cur = ordered[i]!;

    if (cur.sessionId === prev.sessionId) {
      // Same session: `t` is monotonic and comparable. Floor at 0 so a
      // malformed non-monotonic log cannot rewind the clock.
      const delta = Math.max(0, (cur.t ?? 0) - (prev.t ?? 0));
      bundleT[i] = bundleT[i - 1]! + delta;
      continue;
    }

    // Session seam: `t` restarts, so the only comparable signal is wall clock.
    const realGapMs = parseWallMs(cur.wall) - parseWallMs(prev.wall);
    const collapsedGapMs = Number.isFinite(realGapMs)
      ? Math.min(maxSeamGapMs, Math.max(SEAM_FLOOR_MS, realGapMs))
      : SEAM_FLOOR_MS;

    bundleT[i] = bundleT[i - 1]! + collapsedGapMs;
    seams.push({
      atGlobalIdx: i,
      prevSessionId: prev.sessionId,
      nextSessionId: cur.sessionId,
      realGapMs,
      collapsedGapMs,
    });
  }

  return { bundleT, seams };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test --workspace=packages/analyzer -- src/views/replay/bundle-clock.test.ts`
Expected: PASS, all 9 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/analyzer/src/views/replay/bundle-clock.ts \
        packages/analyzer/src/views/replay/bundle-clock.test.ts
git commit --no-gpg-sign -m "feat(analyzer): derive a whole-bundle playback clock

Event t is relative to its own session's start, so it resets at every session
boundary. bundleT accumulates t within a session and inserts a clamped gap at
each seam, staying non-decreasing even under cross-machine clock skew."
```

### Task 5: Point the engine at the whole bundle

**Files:**

- Modify: `packages/analyzer/src/views/replay/engine-core.ts`
- Test: `packages/analyzer/src/views/replay/engine-core.test.ts` (rewrite — 514 lines, currently written against a session-scoped engine)

**Interfaces:**

- Consumes: `buildBundleClock`, `Seam` from Task 4.
- Produces:
  ```ts
  export function createEngine(index: EventIndex): EngineHandle; // sessionId arg removed
  // EngineHandle gains:
  //   seams(): readonly Seam[];
  // ReplayState.sessionId becomes DERIVED: the sessionId of the event at
  // currentGlobalIdx, or the first event's sessionId when currentGlobalIdx === -1.
  ```

Key simplification: with `internal.events = index.ordered`, array position **equals** `globalIdx` (guaranteed by `event-index.ts:32` — `ordered[i].globalIdx === i`). So `globalIdxAtPos` and `posForGlobalIdx` (lines 299-320) collapse to identity and are deleted, along with `seekToPos`'s pos/globalIdx distinction and the compensating comment block at lines 322-330.

- [ ] **Step 1: Rewrite the engine tests**

Read `engine-core.test.ts` in full first. Its fixtures build a single session and assert session-local stepping. Rewrite them around a **two-session** index, keeping every behavior the old tests asserted (seek clamping, checkpoint reuse, step bounds, file state reconstruction) and adding:

```ts
it('steps across a session boundary without resetting', () => {
  const engine = createEngine(twoSessionIndex);
  // last event of session A
  const lastOfA = /* globalIdx */;
  engine.seek(lastOfA);
  const next = engine.step(1);
  expect(next.currentGlobalIdx).toBe(lastOfA + 1);
  expect(next.sessionId).toBe('session-b');
});

it('exposes every file in the bundle, not just the current session', () => {
  const engine = createEngine(twoSessionIndex);
  // hw1.py touched only in session A, hw2.py only in session B
  expect(engine.getFiles()).toEqual(expect.arrayContaining(['hw1.py', 'hw2.py']));
});

it('eventCount covers all sessions', () => {
  expect(createEngine(twoSessionIndex).eventCount()).toBe(twoSessionIndex.ordered.length);
});

it('tick advances through a seam using the collapsed gap', () => {
  const engine = createEngine(twoSessionIndex);
  engine.seek(lastOfA);
  // A tick larger than the collapsed seam gap must land in session B.
  const after = engine.tick(SEAM_MAX_GAP_MS + 1);
  expect(after.sessionId).toBe('session-b');
});

it('endVirtualT is the final bundleT, not the last session-local t', () => {
  const engine = createEngine(twoSessionIndex);
  expect(engine.endVirtualT()).toBe(buildBundleClock(twoSessionIndex.ordered).bundleT.at(-1));
});

it('reports seams', () => {
  expect(createEngine(twoSessionIndex).seams()).toHaveLength(1);
});
```

Any old test that asserted "stepping past the last event of the session stays put" now encodes _changed_ behavior — rewrite it to assert the crossing, and note that in the commit message. Do not delete it.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test --workspace=packages/analyzer -- src/views/replay/engine-core.test.ts`
Expected: FAIL — `createEngine` still takes two arguments and scopes to one session.

- [ ] **Step 3: Modify engine-core.ts**

Changes, in order:

1. Import the clock: `import { buildBundleClock, type Seam } from './bundle-clock.js';`
2. `InternalState` gains `bundleT: Float64Array` and `seams: readonly Seam[]`; `pos` is retained but is now always equal to `state.currentGlobalIdx`.
3. Signature:

   ```ts
   export function createEngine(index: EventIndex): EngineHandle {
     const events = index.ordered;
     const files = computeFiles(events);
     const { bundleT, seams } = buildBundleClock(events);

     const initialState: ReplayState = {
       status: 'paused',
       currentGlobalIdx: -1,
       speed: 1,
       sessionId: events[0]?.sessionId ?? '',
       virtualT: 0,
     };
     // ... internal built with events, bundleT, seams ...
   ```

4. Delete `globalIdxAtPos` and `posForGlobalIdx`. In `seekToPos`, `globalIdx === clamped`, so:

   ```ts
   function seekToPos(pos: number): ReplayState {
     const maxIdx = internal.events.length - 1;
     const clamped = clamp(pos, maxIdx);
     // events === index.ordered, so array position IS the globalIdx
     // (event-index.ts guarantees ordered[i].globalIdx === i).
     const upTo = clamped === -1 ? 0 : clamped + 1;
     // ... checkpoint warm + buildFileStates unchanged ...
     const targetVirtualT = clamped === -1 ? 0 : (internal.bundleT[clamped] ?? 0);
     const sessionId =
       clamped === -1
         ? (internal.events[0]?.sessionId ?? '')
         : (internal.events[clamped]?.sessionId ?? internal.state.sessionId);

     internal.pos = clamped;
     internal.fileStates = newFileStates;
     internal.state = {
       ...internal.state,
       currentGlobalIdx: clamped,
       virtualT: targetVirtualT,
       sessionId,
     };
     return { ...internal.state };
   }
   ```

5. `seek(globalIdx)` becomes `return seekToPos(globalIdx);` — no mapping needed.
6. In `tick`, replace the `internal.events[i]!.t ?? 0` comparison with `internal.bundleT[i] ?? 0`.
7. `endVirtualT()` returns `internal.bundleT[internal.bundleT.length - 1] ?? 0`.
8. Add `seams() { return internal.seams; }` to the handle.
9. Update `computeFiles`'s doc comment: it now derives files from the whole bundle, not one session.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test --workspace=packages/analyzer -- src/views/replay/engine-core.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/analyzer/src/views/replay/engine-core.ts \
        packages/analyzer/src/views/replay/engine-core.test.ts
git commit --no-gpg-sign -m "feat(analyzer): run the replay engine over the whole bundle

createEngine no longer scopes to a session. Because index.ordered guarantees
ordered[i].globalIdx === i, array position now IS the globalIdx, which deletes
the position<->globalIdx mapping the session-scoped engine needed. Playback
timing comes from bundleT instead of the per-session t.

Tests that asserted playback stops at the end of a session are rewritten to
assert the crossing — that behavior is intentionally changed, not relaxed."
```

### Task 6: useReplayEngine + TransportBar

**Files:**

- Modify: `packages/analyzer/src/views/replay/useReplayEngine.ts`
- Modify: `packages/analyzer/src/views/replay/TransportBar.tsx`
- Test: existing `TransportBar` tests; add seam-tick coverage.

**Interfaces:**

- Consumes: `createEngine(index)`, `EngineHandle.seams()` from Task 5.
- Produces: `useReplayEngine(index: EventIndex)` — `sessionId` argument removed. The returned object gains `seams: readonly Seam[]`.

- [ ] **Step 1: Update useReplayEngine**

Drop `sessionId` from the signature and from the `createEngine` call. The reset effect (line 83-92) currently keys on `sessionId` — key it on `index` instead, and reset to `{ status: 'paused', currentGlobalIdx: -1, speed: 1, sessionId: index.ordered[0]?.sessionId ?? '', virtualT: 0 }`. Expose `seams` from the handle. The rAF loop (lines 136-181) needs no change: it already drives `engine.tick()` and compares against `engine.endVirtualT()`.

- [ ] **Step 2: Update TransportBar**

Delete the session-local↔globalIdx translation (the mechanism documented at lines 36-40). The slider's range is now `[-1, index.ordered.length - 1]` and its value **is** `state.currentGlobalIdx`. Add a `seams` prop and render a tick per seam positioned at `seam.atGlobalIdx / (total - 1)`, with a `title` showing the **real** gap (`formatDuration(seam.realGapMs)` → "4h 12m offline"), not the collapsed one.

Write a small pure `formatGap(ms: number): string` helper in `bundle-clock.ts` and unit-test it there (`0 → "0s"`, `65_000 → "1m 5s"`, `15_120_000 → "4h 12m"`, negative → `"unknown"`), rather than inlining formatting in JSX.

- [ ] **Step 3: Write and run the tests**

Add to the `TransportBar` test file:

```tsx
it('renders one seam tick per session boundary', () => {
  render(<TransportBar {...props} seams={[seamAt(10), seamAt(25)]} />);
  expect(screen.getAllByTestId(/^seam-tick-/)).toHaveLength(2);
});

it('labels a seam tick with the real gap, not the collapsed one', () => {
  render(
    <TransportBar
      {...props}
      seams={[{ ...seamAt(10), realGapMs: 15_120_000, collapsedGapMs: 5_000 }]}
    />,
  );
  expect(screen.getByTestId('seam-tick-10')).toHaveAttribute(
    'title',
    expect.stringContaining('4h 12m'),
  );
});
```

Run: `npm run test --workspace=packages/analyzer -- src/views/replay/`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/analyzer/src/views/replay/useReplayEngine.ts \
        packages/analyzer/src/views/replay/TransportBar.tsx \
        packages/analyzer/src/views/replay/TransportBar.test.tsx \
        packages/analyzer/src/views/replay/bundle-clock.ts \
        packages/analyzer/src/views/replay/bundle-clock.test.ts
git commit --no-gpg-sign -m "feat(analyzer): scrub the whole bundle with seam ticks

The transport scrubs index.ordered directly now that array position equals
globalIdx, dropping the session-local mapping. Session boundaries render as
ticks labelled with the real offline duration."
```

### Task 7: Session identifier becomes an entry anchor

**Files:**

- Modify: `packages/analyzer/src/views/replay/ReplayView.tsx`
- Modify: `packages/analyzer/src/views/submission/Replay.tsx`
- Test: both existing test files (`ReplayView.test.tsx` is 492 lines and asserts session-scoped mounting).

**Interfaces:**

- Consumes: `useReplayEngine(index)` from Task 6.

Behavior change:

| Route                      | Before                    | After                                                                        |
| -------------------------- | ------------------------- | ---------------------------------------------------------------------------- |
| `/local/replay/:sessionId` | replays only that session | mounts the whole-bundle engine; seeks to that session's first event on mount |
| `?tab=replay&session=<id>` | replays only that session | same                                                                         |

`?event=<globalIdx>` becomes the position of record and wins over the session anchor when both are present.

- [ ] **Step 1: Write the failing tests**

```tsx
it("seeks to the anchor session's first event on mount", () => {
  // /local/replay/session-b with a two-session index
  // expect the playhead at the globalIdx of session-b's first event
});

it('prefers ?event= over the session anchor', () => {
  // /local/replay/session-b?event=2 where 2 is inside session-a
  // expect the playhead at globalIdx 2
});

it('shows events from every session in the sidebar', () => {
  // mounted at session-b, assert a session-a event row is present
});

it('the session select seeks without clearing the playback position', () => {
  // Replay.tsx: changing the select must NOT delete the event param
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm run test --workspace=packages/analyzer -- src/views/replay/ReplayView.test.tsx src/views/submission/Replay.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Update ReplayView.tsx**

- `useReplayEngine(index)` — drop the `sessionId` argument.
- Replace `const sessionEvents = index?.bySessionId.get(sessionId) ?? []` (line 258) with `index.ordered` for the sidebar and jump-control inputs.
- `eventCount` (line 255) becomes `index.ordered.length`.
- On mount, resolve the initial playhead: `?event=` if present and in range, else the first event of the `:sessionId` anchor, else 0.
- Keep the "session not present in event stream" guard (line 196-199) — it now validates the anchor.
- The header's session dropdown (lines 125-140) becomes a seek: `engine.seek(firstGlobalIdxOf(selectedSessionId))`.

- [ ] **Step 4: Update Replay.tsx**

Same treatment. Critically, `handleSessionChange` (line 124-130) currently does `next.delete('event')` with the comment "Clear playback-position state — it's session-relative." That comment is no longer true — position is whole-bundle. Replace the delete with setting `event` to the target session's first `globalIdx`.

- [ ] **Step 5: Run tests, typecheck, lint**

Run: `npm run test --workspace=packages/analyzer && npm run typecheck --workspace=packages/analyzer && npm run lint --workspace=packages/analyzer`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/analyzer/src/views/replay/ReplayView.tsx \
        packages/analyzer/src/views/replay/ReplayView.test.tsx \
        packages/analyzer/src/views/submission/Replay.tsx \
        packages/analyzer/src/views/submission/Replay.test.tsx
git commit --no-gpg-sign -m "feat(analyzer): treat the replay session id as an entry anchor

Both replay routes keep their URL shape, but :sessionId / ?session= now seek
the whole-bundle engine to that session's first event instead of scoping it.
?event= is the position of record and wins when both are present. The session
select seeks rather than remounting, so it no longer discards the playhead."
```

**PHASE 2 CHECKPOINT** — stop for review before continuing.

---

## Phase 3 — Seam and file-tab UI

### Task 8: Cross-session file tabs

**Files:**

- Create: `packages/analyzer/src/views/replay/file-recency.ts`
- Create: `packages/analyzer/src/views/replay/file-recency.test.ts`
- Modify: `packages/analyzer/src/views/replay/FileTabs.tsx`
- Test: `packages/analyzer/src/views/replay/FileTabs.test.tsx`

**Interfaces:**

- Produces:

  ```ts
  export type FileRecency =
    | { state: 'untouched' } // no event at or before the playhead
    | { state: 'current-session'; agoMs: number } // last edit is in the playhead's session
    | { state: 'earlier-session'; sessionsAgo: number }; // last edit predates it

  export function computeFileRecency(
    index: EventIndex,
    filePath: string,
    currentGlobalIdx: number,
    currentSessionId: string,
  ): FileRecency;

  export function formatRecency(r: FileRecency): string | null; // null when 'untouched'
  ```

Implementation notes: `index.byFile.get(filePath)` is already sorted ascending by `globalIdx`, so binary-search the greatest entry `≤ currentGlobalIdx`. `sessionsAgo` is measured in `index.bySessionId` key order (which `inter-session-external-change.ts:90` documents as session-start chronological order). `agoMs` uses `Date.parse` of the two `wall` values, floored at 0.

- [ ] **Step 1: Write the failing tests**

```ts
describe('computeFileRecency', () => {
  it('returns untouched when the file has no event at or before the playhead', () => {
    expect(computeFileRecency(index, 'hw2.py', 0, 'a')).toEqual({ state: 'untouched' });
  });

  it('returns current-session with the wall delta for a same-session edit', () => {
    expect(computeFileRecency(index, 'hw1.py', 3, 'a')).toEqual({
      state: 'current-session',
      agoMs: 200,
    });
  });

  it('returns earlier-session with the session distance', () => {
    // playhead in session c; hw1.py last touched in session a
    expect(computeFileRecency(index, 'hw1.py', 8, 'c')).toEqual({
      state: 'earlier-session',
      sessionsAgo: 2,
    });
  });

  it("finds the last edit at or before the playhead, not the file's final edit", () => {
    // hw1.py edited at globalIdx 1 and 9; playhead at 5 must resolve to 1
  });
});

describe('formatRecency', () => {
  it('formats a same-session edit as a duration', () => {
    expect(formatRecency({ state: 'current-session', agoMs: 120_000 })).toBe('2m ago');
  });
  it('singularizes one session', () => {
    expect(formatRecency({ state: 'earlier-session', sessionsAgo: 1 })).toBe('1 session ago');
  });
  it('pluralizes multiple sessions', () => {
    expect(formatRecency({ state: 'earlier-session', sessionsAgo: 3 })).toBe('3 sessions ago');
  });
  it('returns null for untouched', () => {
    expect(formatRecency({ state: 'untouched' })).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm run test --workspace=packages/analyzer -- src/views/replay/file-recency.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement file-recency.ts**

Pure module, no React. Binary search over `index.byFile.get(filePath)`.

- [ ] **Step 4: Update FileTabs.tsx**

Props become:

```tsx
type FileTabsProps = {
  files: string[]; // now the whole bundle's files (from engine.getFiles())
  activeFile: string | null;
  currentGlobalIdx: number;
  currentSessionId: string;
  index: EventIndex;
  onFileChange(filePath: string): void;
};
```

Each tab renders `basename(filePath)` plus a recency badge from `formatRecency(...)`. A tab is dimmed (`opacity-50`, plus `title` explaining why) when its recency is `untouched` **or** `earlier-session` — i.e. the file has no event in the session the playhead currently sits in.

In `ReplayView.tsx`, remove any logic that resets `activeFile` when the session changes, so the selection survives seam crossings. If `activeFile` is not in `files`, fall back to the first file (existing behavior).

- [ ] **Step 5: Write and run the FileTabs tests**

```tsx
it('renders a tab for a file touched only in an earlier session', () => {
  /* … */
});
it('dims a file with no event in the current session', () => {
  /* … */
});
it('shows a session-distance badge for an earlier-session file', () => {
  /* … */
});
it('keeps the active file selected when the playhead crosses a seam', () => {
  /* … */
});
```

Run: `npm run test --workspace=packages/analyzer -- src/views/replay/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/analyzer/src/views/replay/file-recency.ts \
        packages/analyzer/src/views/replay/file-recency.test.ts \
        packages/analyzer/src/views/replay/FileTabs.tsx \
        packages/analyzer/src/views/replay/FileTabs.test.tsx \
        packages/analyzer/src/views/replay/ReplayView.tsx
git commit --no-gpg-sign -m "feat(analyzer): show every bundle file in the replay tab strip

A file edited in session 1 and untouched in session 2 used to vanish from the
tab strip, even though its content was still reconstructable. Tabs now cover
the whole bundle, carry a last-edited badge, dim when untouched in the current
session, and keep their selection across seams."
```

### Task 9: Seam dividers in the Events sidebar

**Files:**

- Modify: `packages/analyzer/src/views/replay/EventSidebar.tsx`
- Test: `packages/analyzer/src/views/replay/EventSidebar.test.tsx`

**Interfaces:**

- Consumes: `Seam` and `formatGap` from `bundle-clock.ts`.
- Produces: `EventSidebarProps` gains `seams: readonly Seam[]` and `flaggedSeamIdxs?: ReadonlySet<number>` (see Task 11).

The sidebar is fed `index.ordered` (done in Task 7). It builds a display array interleaving seam rows, and the virtualizer gets a variable `estimateSize`:

```tsx
type Row = { type: 'event'; event: IndexedEvent } | { type: 'seam'; seam: Seam };

const EVENT_ROW_HEIGHT = 30; // existing ROW_HEIGHT
const SEAM_ROW_HEIGHT = 44;

const rows = useMemo<Row[]>(() => {
  const seamByIdx = new Map(seams.map((s) => [s.atGlobalIdx, s]));
  const out: Row[] = [];
  for (const event of events) {
    const seam = seamByIdx.get(event.globalIdx);
    if (seam) out.push({ type: 'seam', seam });
    out.push({ type: 'event', event });
  }
  return out;
}, [events, seams]);
```

`useVirtualizer`'s `estimateSize: (i) => (rows[i]?.type === 'seam' ? SEAM_ROW_HEIGHT : EVENT_ROW_HEIGHT)`. The existing auto-scroll effect maps `currentGlobalIdx` → row index; update it to search `rows` rather than `events`, and keep its "don't fight manual scroll" guard intact.

The divider label uses `formatGap(seam.realGapMs)` — the **real** duration, e.g. "4h 12m offline" — not `collapsedGapMs`.

- [ ] **Step 1: Write the failing tests**

```tsx
it('inserts a seam divider before the first event of the next session', () => {
  /* … */
});
it('labels the divider with the real gap, not the collapsed one', () => {
  /* … */
});
it('renders no dividers for a single-session bundle', () => {
  /* … */
});
it('still auto-scrolls to the current event with dividers present', () => {
  /* … */
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm run test --workspace=packages/analyzer -- src/views/replay/EventSidebar.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement, then run to verify they pass**

Run: `npm run test --workspace=packages/analyzer -- src/views/replay/`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/analyzer/src/views/replay/EventSidebar.tsx \
        packages/analyzer/src/views/replay/EventSidebar.test.tsx
git commit --no-gpg-sign -m "feat(analyzer): mark session seams in the replay event sidebar

The sidebar spans the whole bundle now, so session boundaries need to be
visible. Dividers carry the real offline duration; the virtualizer sizes them
separately from event rows."
```

### Task 10: Jump to next seam

**Files:**

- Modify: `packages/analyzer/src/views/replay/jump-predicates.ts`
- Modify: `packages/analyzer/src/views/replay/JumpControls.tsx`
- Test: `packages/analyzer/src/views/replay/jump-predicates.test.ts`, `JumpControls.test.tsx`

**Interfaces:**

- Produces, matching the existing `findNextPaste` / `countRemainingPastes` style (`jump-predicates.ts:46,184`):

  ```ts
  export function findNextSeam(seams: readonly Seam[], currentGlobalIdx: number): number | null;
  export function countRemainingSeams(seams: readonly Seam[], currentGlobalIdx: number): number;
  ```

  `findNextSeam` returns the `atGlobalIdx` of the first seam strictly after `currentGlobalIdx`, or `null`.

- [ ] **Step 1: Write the failing tests**

```ts
it('finds the next seam strictly after the current position', () => {
  expect(findNextSeam([{ atGlobalIdx: 5 }, { atGlobalIdx: 12 }] as Seam[], 5)).toBe(12);
});
it('returns null when no seam follows', () => {
  expect(findNextSeam([{ atGlobalIdx: 5 }] as Seam[], 5)).toBeNull();
});
it('returns null for a single-session bundle', () => {
  expect(findNextSeam([], 0)).toBeNull();
});
it('counts only seams after the current position', () => {
  expect(countRemainingSeams([{ atGlobalIdx: 5 }, { atGlobalIdx: 12 }] as Seam[], 5)).toBe(1);
});
```

- [ ] **Step 2: Run to verify they fail, implement, run to verify they pass**

Run: `npm run test --workspace=packages/analyzer -- src/views/replay/jump-predicates.test.ts`

- [ ] **Step 3: Wire the button into JumpControls**

Read `JumpControls.tsx` first and follow the exact pattern the existing paste / external-change / flag / file-switch buttons use — same disabled-when-null behavior, same remaining-count badge, same icon convention (`lucide-react`). Hide the control entirely when `seams.length === 0` so single-session bundles are visually unchanged.

- [ ] **Step 4: Run the suite and commit**

```bash
git add packages/analyzer/src/views/replay/jump-predicates.ts \
        packages/analyzer/src/views/replay/jump-predicates.test.ts \
        packages/analyzer/src/views/replay/JumpControls.tsx \
        packages/analyzer/src/views/replay/JumpControls.test.tsx
git commit --no-gpg-sign -m "feat(analyzer): add a jump-to-next-session-seam control"
```

### Task 11: Surface inter_session_external_change on its seam

**Files:**

- Modify: `packages/analyzer/src/views/replay/EventSidebar.tsx` (marking)
- Modify: `packages/analyzer/src/views/replay/ReplayView.tsx` (compute the flagged set)
- Create: `packages/analyzer/src/views/replay/seam-flags.ts`
- Test: `packages/analyzer/src/views/replay/seam-flags.test.ts`

**Interfaces:**

- Consumes: `buildFlaggedGlobalIdxSet` (`jump-predicates.ts:92`), which already resolves `${sessionId}:${seq}` supporting-seq strings against `index.bySeq`.
- Produces:
  ```ts
  export function buildFlaggedSeamIdxs(
    seams: readonly Seam[],
    flags: readonly Flag[],
    bySeq: EventIndex['bySeq'],
  ): Set<number>; // set of seam.atGlobalIdx values
  ```

A seam is flagged when a supporting event of an `inter_session_external_change` flag has `globalIdx >= seam.atGlobalIdx` and belongs to `seam.nextSessionId`. Per the heuristic's own docs (`inter-session-external-change.ts:26`), the supporting seq is the next session's first `doc.open` for the diverged file — so it always falls inside `nextSessionId`.

- [ ] **Step 1: Write the failing tests**

```ts
it('flags the seam whose next session carries the supporting event', () => {
  /* … */
});
it('ignores flags of other heuristic ids', () => {
  /* … */
});
it('returns an empty set when there are no seams', () => {
  /* … */
});
it('handles a supporting seq that is not present in bySeq', () => {
  /* … */
});
```

Read `analysis-core/src/heuristics/types.ts` for the exact `Flag` shape and the heuristic id string before writing these — use the real id, do not guess it.

- [ ] **Step 2: Run to verify they fail, implement, run to verify they pass**

Run: `npm run test --workspace=packages/analyzer -- src/views/replay/seam-flags.test.ts`

- [ ] **Step 3: Render the marking**

`ReplayView.tsx` already receives `flags`. Compute `flaggedSeamIdxs` with `useMemo` and pass it to `EventSidebar`. A flagged divider renders in the warning treatment already used for `fs.external_change` (`KIND_CHIP_CLASSES` uses `bg-red-100 text-red-700`) with explanatory text: "file content changed while the recorder was off".

- [ ] **Step 4: Full verification**

Run: `npm run test --workspace=packages/analyzer && npm run typecheck --workspace=packages/analyzer && npm run lint --workspace=packages/analyzer`
Expected: all pass.

Then run the full workspace suite once, since `analysis-core` types are consumed here:

Run: `npm run typecheck && npm run lint`
Expected: pass. (`npm run test` at the root requires Docker for the server integration tests — run it if Docker is available, otherwise note that it was skipped.)

- [ ] **Step 5: Commit**

```bash
git add packages/analyzer/src/views/replay/seam-flags.ts \
        packages/analyzer/src/views/replay/seam-flags.test.ts \
        packages/analyzer/src/views/replay/EventSidebar.tsx \
        packages/analyzer/src/views/replay/ReplayView.tsx
git commit --no-gpg-sign -m "feat(analyzer): mark seams carrying inter_session_external_change

The heuristic detects file content diverging between one session's end and the
next session's first doc.open. That moment was previously unreachable in replay
because the playhead could never sit at a session boundary."
```

**PHASE 3 CHECKPOINT** — final review.

---

## Spec Coverage

| Spec section                           | Task                   |
| -------------------------------------- | ---------------------- |
| 1.1 `bundle-clock.ts`                  | 4                      |
| 1.2 `engine-core.ts` whole-bundle      | 5                      |
| 1.3 `useReplayEngine`                  | 6                      |
| 1.4 `FileTabs` (all 4 behaviors)       | 8                      |
| 1.5 `EventSidebar` seam rows           | 9                      |
| 1.6 Seam flag surfacing                | 11                     |
| 1.7 `jump-predicates` + `JumpControls` | 10                     |
| 1.8 `TransportBar`                     | 6                      |
| 1.9 Routing / entry anchor             | 7                      |
| Part 2 events page unification         | 1, 2, 3                |
| Error handling: event ceiling          | 3                      |
| Error handling: single-session         | 4 (empty seams), 9, 10 |
| Error handling: zero-event             | 4                      |
| Error handling: clock skew             | 4                      |
| Error handling: unknown session in URL | 7                      |

## Known Cost

`engine-core.test.ts` (514 lines) and `ReplayView.test.tsx` (492 lines) are written against a session-scoped engine and are rewritten in Tasks 5 and 7. This is genuine rework, not fixture renaming. Tests encoding behavior this plan intentionally changes get rewritten to encode the new behavior — never deleted or loosened.
