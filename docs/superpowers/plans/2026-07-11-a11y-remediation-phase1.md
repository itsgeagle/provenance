# WCAG 2.1 AA Remediation — Phase 1 (Critical + systemic wins) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Fix all 8 Critical WCAG blockers plus the highest-leverage shared-component/token root causes in the analyzer SPA (`packages/analyzer`), so the fixes cascade across many views.

**Architecture:** Foundations first (design tokens, shared primitives: status/route regions, `SortableHeader`, clickable-row, slider/dropdown fixes), then apply them to the specific Critical views. Source of truth for each fix is `docs/accessibility/wcag-2.1-aa-audit-2026-07-11.md` (themes T1–T12, roadmap P0/P1) — every task cites its theme.

**Tech stack:** React 18, Tailwind (shadcn CSS-var tokens), Radix primitives, react-router v6, Vitest + Testing Library + `@testing-library/jest-dom`.

## Global Constraints

- **Working dir:** all paths under `packages/analyzer/`. Run tests: `npm run test --workspace=packages/analyzer -- <file>`; typecheck `npm run typecheck --workspace=packages/analyzer`; lint `npm run lint --workspace=packages/analyzer`.
- **ESM relative imports MUST use `.js`** extensions (`import { X } from './X.js'`). Path alias `@/` maps to `src/` (used by `ui/*`).
- TypeScript strict; no `any`.
- Tests colocated, deterministic. Prefer role/name queries (`getByRole`) — they double as a11y assertions. Every task adds tests proving the a11y fix (e.g. `getByRole('slider', { name: … })`, `aria-sort`, `role="alert"`), and existing tests must stay green.
- **Do not change product behavior or visual layout beyond what the fix requires.** These are accessibility fixes, not redesigns.
- **Commits:** conventional prefix, `git commit --no-gpg-sign`, NO `Co-Authored-By` trailer. **Always stage with an explicit pathspec** (`git commit -- <files>` or `git add <exact files>` then verify `git diff --cached --name-only` before commit) — the working tree contains unrelated staged changes that must never be swept in. Branch: `feat/a11y-remediation-phase1`.
- **Contrast target:** normal text ≥4.5:1, large text (≥18.66px bold / ≥24px) ≥3:1, non-text/UI ≥3:1.

---

### Task 1 — Design token: darken `--destructive` (T1, P1-1)

**Files:** `src/styles/globals.css`; tests via any existing badge/button test.
**Fix:** In `globals.css`, change `--destructive` from `0 84.2% 60.2%` (≈#ef4444, ~3.6:1 vs near-white fg) to approximately `0 72% 42%` (Tailwind red-600/700 range) in BOTH `:root` and `.dark` (pick a `.dark` value that keeps ≥4.5:1 against its `--destructive-foreground`). Leave `--destructive-foreground` as-is.
**Acceptance:** Document the computed contrast ratio (≥4.5:1) in a comment. `button.tsx`/`badge.tsx` destructive variants unchanged in code (they inherit the token). Existing `button.test.tsx`/`badge.test.tsx` pass.
- [ ] Write/adjust a test asserting the destructive variant renders (existing tests likely suffice); compute and note the new ratio.
- [ ] Edit the token in `:root` and `.dark`.
- [ ] Run `button.test.tsx badge.test.tsx`, typecheck, lint. Commit.

---

### Task 2 — `ui/slider.tsx`: forward accessible name + valuetext to the Thumb (T8, P0-1) ★

**Files:** `src/components/ui/slider.tsx` (+ new `slider.test.tsx` if absent).
**Root bug:** `aria-label` is spread onto `SliderPrimitive.Root`, but the focusable `role="slider"` element is `SliderPrimitive.Thumb`. Radix does not forward it, so every slider (incl. the replay scrub) is anonymous.
**Fix:** Destructure `['aria-label']`, `['aria-labelledby']`, and `['aria-valuetext']` out of `props` and apply them to `<SliderPrimitive.Thumb>` (keep the rest on Root). Also give the track a visible boundary: add `border border-border` to the `Track` (T3, folds in P1-4's track fix). Keep everything else identical.
**Acceptance:** `render(<Slider aria-label="Scrub" defaultValue={[3]} max={10} />)` → `getByRole('slider', { name: /scrub/i })` passes. Track has a border class.
- [ ] Write failing test (`getByRole('slider', { name: 'Scrub' })`).
- [ ] Implement the thumb passthrough + track border. Run test → pass.
- [ ] Typecheck, lint, commit.

---

### Task 3 — `ui/dropdown-menu.tsx` focus ring + `ui/progress.tsx` track border (T3, P1-4) ★

**Files:** `src/components/ui/dropdown-menu.tsx`, `src/components/ui/progress.tsx`; existing tests.
**Fix:** On the interactive menu-item classes (Item, CheckboxItem, RadioItem — the audit cites lines ~30/84/100/123) add a focus indicator independent of `--accent`: append `focus:ring-2 focus:ring-ring focus:ring-inset` (keep existing `focus:bg-accent`). In `progress.tsx` add `border border-border` to the track div (`:18`).
**Acceptance:** Classes present; existing `dropdown-menu.test.tsx`/`progress.test.tsx` still pass (add an assertion that a menu item carries the ring class if straightforward).
- [ ] Add ring classes to the three item variants + progress track border.
- [ ] Run the two tests, typecheck, lint. Commit.

---

### Task 4 — Shared status/error live regions + route guard loading/error (T6, P1-3) ★

**Files:** Create `src/components/a11y/StatusRegion.tsx` (`role="status" aria-live="polite"`), `src/components/a11y/ErrorRegion.tsx` (`role="alert"`), `src/components/a11y/RouteLoading.tsx` + `RouteError.tsx` (centered wrappers using StatusRegion/ErrorRegion, contrast-safe `text-gray-600`); tests for each. Then apply `RouteLoading`/`RouteError` in `src/auth/RequireAuth.tsx`, `RequireStaff.tsx`, `RequireSuperadmin.tsx` (replace the bare `<span>Loading…</span>` / error `<span>` — and fix their `text-gray-400`/`gray-500` to `gray-600`).
**Interfaces (later tasks rely on these names):**
- `StatusRegion({ children, className? })` → `<div role="status" aria-live="polite">`.
- `ErrorRegion({ children, className? })` → `<div role="alert">`.
- `RouteLoading({ label? = 'Loading…' })`, `RouteError({ message })`.
**Acceptance:** Unit tests assert `getByRole('status')` / `getByRole('alert')` and text. Guard tests updated: RequireAuth/RequireStaff/RequireSuperadmin loading state exposes `role="status"`; error state `role="alert"`. Existing guard tests still pass (they query by text/redirect).
- [ ] TDD each primitive; then wire the three guards; run `src/auth/*.test.tsx` + the new tests. Commit.

---

### Task 5 — Contrast sweep: `text-gray-400`/`-300` on meaningful text → `gray-600`/`gray-700`; `text-red-500` load-errors → `text-destructive` (T1/T2, P1-2) ★

**Files (from the audit's enumerated sites — read each, replace only where the text is MEANINGFUL content, not true decoration):** `src/views/cohort/CohortView.tsx`, `CohortTable.tsx`, `StudentRollupTable.tsx`, `FilterRail.tsx`; `src/views/submission/Overview.tsx`, `Timeline.tsx`; `src/views/cross-flags/CrossFlagListView.tsx`; `src/views/ingest/IngestJobView.tsx`; `src/views/admin/AdminCoursesView.tsx`, `AdminSemestersView.tsx`, `AdminUsersView.tsx`, `AdminUserDetailView.tsx`, `AdminAuditView.tsx`; `src/views/compare/CompareView.tsx` (`text-amber-600`→`text-amber-700`). For load-error text using `text-red-500`, switch to `text-destructive`.
**Guidance:** On white use `text-gray-600`; on `bg-gray-50` headers use `text-gray-700`. Leave genuinely decorative helper copy that is non-essential as-is only if it's non-informational; when in doubt, upgrade it. `text-gray-300` sequence numbers (`Timeline.tsx:181`) → `text-gray-600`.
**Acceptance:** `grep -rn "text-gray-400\|text-gray-300\|text-red-500" src/views/{cohort,submission,cross-flags,ingest,admin,compare}` shows no remaining hits on meaningful text in the touched files (note any deliberately-kept decorative ones in the commit body). All touched views' existing tests pass.
- [ ] Sweep the files; run the affected view tests + typecheck + lint. Commit. (Mechanical; no new tests required beyond keeping existing green, but add one assertion where a test already renders the affected text.)

---

### Task 6 — Shared `SortableHeader` + clickable-row pattern (T4, P1-5) ★

**Files:** Create `src/components/a11y/SortableHeader.tsx` and `src/components/a11y/clickable-row.ts` (or a `RowLink` component) + tests.
**Design:**
- `SortableHeader({ label, sortState, onSort, className? })` renders `<th>` containing a real `<button>`; sets `aria-sort` on the `<th>` to `'ascending' | 'descending' | 'none'` from `sortState`; the button toggles via `onSort` (keyboard-operable for free).
- Clickable-row helper: prefer a `RowLink`/cell-level `<Link>`/`<button>` pattern. Provide the pattern that later tasks apply: the primary cell wraps its content in a keyboard-focusable control (`<Link to>` if it navigates, else `<button>`), NOT `onClick` on `<tr>`. Include a visible `focus-visible:ring-2` and keep row hover styling.
**Acceptance:** `SortableHeader` test: `getByRole('columnheader')` has `aria-sort` reflecting state; the inner `getByRole('button', { name })` fires `onSort` on Enter/Space (native button). Clickable-row test: the row's action is a `link`/`button` reachable by keyboard.
- [ ] TDD both. Run tests, typecheck, lint. Commit.

---

### Task 7 — CohortTable: keyboard drill-in + sortable headers (T4, P0-3/P0-4)

**Files:** `src/views/cohort/CohortTable.tsx` + test.
**Fix:** Replace `<tr onClick>` (≈:344-348) drill-in with the clickable-row pattern from Task 6 (a `<Link>` to the submission in the primary cell; keep row visuals). Replace the sortable `<th onClick>` (≈:320-329) with `SortableHeader` (aria-sort + keyboard). Add `aria-label` to the score-severity dot (≈:189-203) since it's color+title only (T11 spillover, cheap here).
**Acceptance:** Test: a submission is reachable by keyboard (a `link`/`button` with the row's accessible name, correct `href`); a column header exposes `aria-sort` and sorts on keyboard activation. Existing CohortTable tests pass.
- [ ] TDD, run `CohortTable.test.tsx`, typecheck, lint. Commit.

---

### Task 8 — StudentRollupTable: sortable headers (T4, P0-4)

**Files:** `src/views/cohort/StudentRollupTable.tsx` + test.
**Fix:** Replace sortable `<th onClick>` (≈:227-236) with `SortableHeader`. Fix the `text-gray-400` empty-dash if still present (may be covered by Task 5).
**Acceptance:** Header exposes `aria-sort`, sorts via keyboard. Existing tests pass.
- [ ] TDD, run test, typecheck, lint. Commit.

---

### Task 9 — CrossFlagListView: keyboard-accessible rows (T4, P0-3)

**Files:** `src/views/cross-flags/CrossFlagListView.tsx` + test.
**Fix:** Replace click-only `<tr onClick>` (≈:180-195) with the clickable-row pattern (a `<Link>` to the cross-flag detail in the primary cell).
**Acceptance:** Detail is reachable by keyboard (link with correct `href`/name). Existing tests pass.
- [ ] TDD, run test, typecheck, lint. Commit.

---

### Task 10 — TuningView: accessible names for the 24 sliders (T8, P0-2)

**Files:** `src/views/heuristics/TuningView.tsx` + test.
**Fix:** The 24 weight `<input type="range">` (≈:283-292) have no name. Point each slider's `aria-labelledby` at the heuristic's existing label `<span id>` (≈:270; add stable `id`s if missing), and give the paired enable checkbox an `aria-label={`Enable ${id}`}`. Add `aria-valuetext` if the numeric value needs context.
**Acceptance:** Test: `getAllByRole('slider')` each has an accessible name matching its heuristic; the enable checkbox has a name. Existing TuningView tests pass.
- [ ] TDD (assert a representative slider/checkbox name), run `TuningView.test.tsx`, typecheck, lint. Commit.

---

### Task 11 — SemesterSettingsView + RegexTester: associate labels (T9, P0-6)

**Files:** `src/views/settings/SemesterSettingsView.tsx` + test.
**Fix:** The four settings fields (≈:154-224) and the `RegexTester` sample input (≈:47-54) have unlinked `<label>` siblings. Add matching `htmlFor`/`id` (or wrap input in `<label>`). Wire any inline validation error via `aria-describedby` + `aria-invalid` on the input, and render the error through `ErrorRegion` (Task 4).
**Acceptance:** Test: each field is retrievable via `getByLabelText(...)`; an errored field has `aria-invalid` + `aria-describedby`. Existing tests pass.
- [ ] TDD, run test, typecheck, lint. Commit.

---

### Task 12 — RosterView UploadModal → Radix Dialog (T5, P0-5)

**Files:** `src/views/roster/RosterView.tsx` + test.
**Fix:** Replace the hand-rolled `UploadModal` (≈:70-193, plain `fixed inset-0` overlay containing a destructive delete) with the shared `components/ui/dialog` (Radix): `Dialog`/`DialogContent`/`DialogTitle`/`DialogDescription`. This supplies `role="dialog"`, `aria-modal`, focus trap, Escape, and focus restore for free. Keep the upload/delete behavior identical. Ensure the destructive delete button has a clear accessible name.
**Acceptance:** Test: opening the modal exposes `getByRole('dialog', { name: … })`; Escape/overlay close works; focus moves in. Existing RosterView tests pass (update any that asserted the old markup).
- [ ] TDD, run `RosterView.test.tsx`, typecheck, lint. Commit.

---

### Task 13 — Tab semantics: SubmissionShell drill-in + CohortView toggle (T7, P1-8)

**Files:** `src/views/submission/SubmissionShell.tsx`, `src/views/cohort/CohortView.tsx` + tests.
**Fix:** `SubmissionShell` (≈:75-88) 6-tab nav → proper tabs: `role="tablist"`, each tab `role="tab"` + `aria-selected` + `aria-controls`, panel `role="tabpanel"`; add `focus-visible:ring-2` and a non-color active cue (underline/weight) — remove bare `focus:outline-none`. Prefer the shared Radix `Tabs` primitive if it fits the routing model; otherwise apply the WAI-ARIA tabs attributes to the existing buttons/links. `CohortView` (≈:266-281) "By submission / By student" toggle → `aria-pressed` on each button (or tablist) + focus ring.
**Acceptance:** Test: the active drill-in tab has `aria-selected="true"` and a focus ring class; the cohort toggle exposes `aria-pressed`. Existing tests pass.
- [ ] TDD, run both view tests, typecheck, lint. Commit.

---

### Task 14 — Apply status/error regions to the submission drill-in async states (T6, P1-3 cont.)

**Files:** `src/views/submission/Overview.tsx`, `Validation.tsx`, `Timeline.tsx`, `Source.tsx`, `Replay.tsx` + their tests.
**Fix:** Each repeats a plain `<div>` loading/error block with no live region (audit T6). Route each loading state through `StatusRegion` and each error state through `ErrorRegion` (Task 4). Keep visuals; just add the roles + fix any `text-gray-400`.
**Acceptance:** Test (one representative per view or a shared helper test): the loading state is a `role="status"`, the error state a `role="alert"`. Existing drill-in tests pass.
- [ ] TDD, run the five view tests, typecheck, lint. Commit.

---

### Task 15 — Full-suite verification

- [ ] `npm run test --workspace=packages/analyzer` (whole suite green).
- [ ] `npm run typecheck --workspace=packages/analyzer` and `npm run lint --workspace=packages/analyzer` clean.
- [ ] `npm run build --workspace=packages/analyzer` succeeds.
- [ ] Optional manual: run the dev server and keyboard-tab through cohort → submission drill-in → replay scrub, confirming focus is visible and controls are named.

---

## Notes / deferred to Phase 2
Not in this pass (tracked in the audit roadmap): P1-6 shared `ProgressBar` (recompute/ingest), P1-7 remaining hand-rolled modals (`AttachModal`, `CrossFlagDetailPane`, `SavedViews`), P1-9 remaining label associations (FilterRail, MembersView, Timeline file filter), P1-10/11/14 replay Monaco/EventSidebar keyboard, P1-12 reflow, P1-13 gutter color cues, and all P2/P3. The shared primitives built here (StatusRegion/ErrorRegion/RouteLoading/RouteError, SortableHeader, clickable-row, ProgressBar-to-come) are the reuse surface for those.

## Self-review
- Every P0 (P0-1…P0-6) has a task: slider Task 2, TuningView Task 10, click-rows Tasks 7/9, sort headers Tasks 7/8, RosterView modal Task 12, SemesterSettings Task 11. ✓
- Systemic ★: tokens Task 1, contrast sweep Task 5, status/route Tasks 4/14, dropdown/track Tasks 2/3, SortableHeader/clickable-row Task 6, tabs Task 13. ✓
- Ordering: foundations (1–6) precede consumers (7–14). Task 6 primitives are consumed by 7/8/9; Task 4 primitives by 11/14. ✓
- No placeholder code left unspecified: shared-primitive tasks give interfaces; consumer tasks cite audit file:line + approach and require the implementer to read source and TDD. This is a deliberate adaptation — the audit report is the detailed spec.
