# Provenance Analyzer — Phased Implementation Plan

**Scope:** `packages/analyzer` only. The recorder (`packages/recorder`) and the shared format (`packages/log-core`) are complete. The analyzer consumes the bundle the recorder produces (PRD §5.3) and renders it for course staff.

**Target end states:**

- **v1 (Phases 0–10)** — PRD §8 v1: bundle load + validation + raw timeline + four highest-value heuristics (`large_paste`, `external_edits`, `low_typing_high_output`, `chain_broken`) + markdown findings export.
- **v2 (Phases 11–19)** — PRD §8 v2: replay UI (Monaco, scrub/step/speed, gutter coloring, hover attribution), full heuristic suite from §7.4 (process-shape + environment + integrity + cross-submission), PDF findings export.

**Explicitly v3 (out of scope for this plan):** LLM-assisted review (PRD §7.6), server-side verification (PRD §8 v3), non-VS-Code editor support, server-side bulk-review mode.

**Reading order:** every phase references PRD sections. Re-read the section before writing the phase. Per CLAUDE.md, the PRD wins on behavior disputes; this file wins on code conventions.

---

## 0. Decisions that gate everything

CLAUDE.md forbids new dependencies without approval. Decisions below are made up front because v1 and v2 build on the same foundation — switching foundations later (e.g., adding a router after components are built without one) is a much bigger diff than adopting it on day one. Each is justified by a PRD or CLAUDE.md anchor.

### Dependencies needing approval

| Dependency                                   | Used in | Used for                                                               | Proposed pick                                                                                                  | Rationale                                                                                                                                                                                        |
| -------------------------------------------- | ------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| React 18 + TypeScript                        | v1      | UI runtime                                                             | `react@^18`, `react-dom@^18`                                                                                   | PRD §7.1 names "React + Vite + TypeScript" explicitly. React 18 is the stable line; 19 isn't required.                                                                                           |
| Vite                                         | v1      | Static SPA bundler + dev server                                        | `vite@^5`, `@vitejs/plugin-react@^4`                                                                           | PRD §7.1.                                                                                                                                                                                        |
| JSZip                                        | v1      | Read submission ZIP in-browser (PRD §5.3)                              | `jszip@^3.10`                                                                                                  | Already approved + used by recorder for seal. Same lib end-to-end avoids format drift.                                                                                                           |
| Vitest + jsdom                               | v1      | Component + unit tests                                                 | `vitest` (root dep), `jsdom@^25`                                                                               | Vitest already used everywhere else; jsdom is the standard env for React tests.                                                                                                                  |
| React Testing Library                        | v1      | DOM-shape tests                                                        | `@testing-library/react`, `@testing-library/jest-dom`                                                          | Idiomatic for React + Vitest.                                                                                                                                                                    |
| `@tanstack/react-virtual`                    | v1      | Virtualize raw timeline + event log (PRD §7.3)                         | `@tanstack/react-virtual@^3`                                                                                   | Tiny, headless, no theming opinions.                                                                                                                                                             |
| **`react-router`**                           | **v1**  | Routing                                                                | `react-router-dom@^6`                                                                                          | v2's replay view needs deep-linking (`/replay/:sessionId?event=:seq&speed=:n`). Wiring routing on day 1 is much cheaper than retrofitting.                                                       |
| **`tailwindcss`**                            | **v1**  | Styling                                                                | `tailwindcss@^3`, `postcss`, `autoprefixer`                                                                    | v2's replay UI has dialogs, sliders, dropdowns, tooltips, gutter overlays. Utility-first scales with component count; CSS Modules don't.                                                         |
| **`shadcn/ui` primitives (Radix + helpers)** | **v1**  | Accessible UI primitives (Dialog, Slider, Tooltip, DropdownMenu, etc.) | `@radix-ui/react-*` (per primitive used), `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react` | shadcn/ui scaffolds components into `src/components/ui/` (we own the code, no runtime lib). Gets accessibility right by default — focus traps, ARIA, keyboard. v2 replay UI especially benefits. |
| `diff`                                       | v2      | Fuzzy line match for `paste_matches_known_source`                      | `diff@^7`                                                                                                      | Standard line-diff lib; small.                                                                                                                                                                   |
| `monaco-editor` + `@monaco-editor/react`     | v2      | Replay editor (PRD §7.2)                                               | `monaco-editor@^0.52`, `@monaco-editor/react@^4`                                                               | PRD §7.2 names Monaco explicitly. Lazy-loaded only on `/replay` route to keep initial bundle small.                                                                                              |
| `jspdf` + `html2canvas`                      | v2      | PDF findings export (PRD §7.5)                                         | `jspdf@^2.5`, `html2canvas@^1.4`                                                                               | PRD §7.5 lists PDF as a target. v1 ships markdown; v2 adds PDF with embedded screenshots of replay key moments.                                                                                  |

No new crypto / format deps needed at any stage: the analyzer reuses `@provenance/log-core` (which already pulls `@noble/ed25519`, `@noble/hashes`, `canonicalize`). All three are pure-JS and run in the browser unchanged — this is the architectural guarantee log-core has been enforcing.

### Other up-front decisions (proposals; redirect before Phase 0 if wrong)

1. **Routing.** `react-router-dom@6` with a `<BrowserRouter>` at the root. v1 routes: `/load`, `/overview`, `/timeline`. v2 adds: `/replay/:sessionId` (with `?event=&speed=` search params), `/compare` (cross-submission), `/flags/:flagId` (drill-in view, possibly a modal not a route). The bundle context provider sits inside the router root so all routes can read it.
2. **Styling.** Tailwind 3 + shadcn/ui scaffolding. The shadcn init is one-time in Phase 0; subsequent components are pulled in via `npx shadcn add <name>` as needed. No theme customization initially — start with the default neutral palette. Accent color (one) added when the flag dashboard goes in.
3. **State management.** React context + URL state via the router. The bundle (or bundle set, in v2) is loaded once and immutable; components read from `BundleContext`. **Known v2 refactor point:** `BundleContext` becomes `BundleSetContext` in Phase 11 to support multiple loaded bundles. Designed for this from day one — the context value type is `{ bundles: Bundle[] }` even in v1 (with `bundles.length === 1`), so the type doesn't change later, only the loader does.
4. **Workspace integration.** `packages/analyzer/package.json` declares `"@provenance/log-core": "*"` (npm workspaces, same pattern as recorder). Vite resolves it via the built `dist/`.
5. **ESLint boundary.** Mirror log-core's boundary in reverse: forbid `node:*`, `fs`, `path`, `worker_threads`, `crypto` imports under `packages/analyzer/src/`. Web Crypto is fine (it's a global). Phase 0 lands this rule.
6. **Test bundle fixture.** `packages/analyzer/test/fixtures/` holds a real `.zip` produced by the recorder against `test-workspace/`. Use the existing `test-workspace/.provenance/` outputs plus one `seal` run, committed as a binary. Regenerate via a documented script if the format ever changes.
7. **No backend.** PRD §3 + §7.1: "No backend." The bundle never leaves the browser tab.
8. **chain_broken heuristic.** Already produced by `log-core`'s `validateChain`. We do **not** reimplement it inside the heuristics engine; we surface the validator's break (if any) as a high-severity Flag through `heuristics/integrity-flags.ts`. Same pattern applies to other PRD §7.4 integrity heuristics in v2.
9. **Monaco loading.** Lazy-loaded **only** on the `/replay` route via `React.lazy()`. Vite splits Monaco into its own chunk automatically when imported dynamically. Initial bundle stays small for users who only need overview/timeline.
10. **Browser support.** Evergreen Chrome / Firefox / Safari. Vite's default `esbuild` target is fine.
11. **Accessibility.** Semantic HTML, keyboard navigation, focus management in modals/drawers, ARIA labels on icon-only buttons. shadcn/ui (Radix) gets most of this right by default. RTL tests assert keyboard reachability for interactive elements.

If any of these are wrong, redirect before Phase 0.

---

## Working agreement (recap — same as recorder build)

- **Branch:** `analyzer-v1` off `main` for Phases 0–10, then `analyzer-v2` off `main` after v1 merges, for Phases 11–20. v2 work doesn't start until v1 has shipped end-to-end against real fixtures.
- **Subagent-driven execution.** Each phase: dispatch implementer → spec-compliance review → code-quality review → mark complete → next phase. Sequential only.
- **Diffs ≤ ~200 lines / ~5 files** per phase commit (CLAUDE.md). Phases that don't fit get split when implemented — Phases 13, 14, 17 are likely candidates.
- **Co-located tests.** `foo.tsx` and `foo.test.tsx` in the same dir. UI components get RTL tests; pure logic gets unit tests.
- **Deterministic tests.** Inject a clock; never read `Date.now()` in assertions.
- **Update `.notes/progress.md`** (or `.notes/analyzer-progress.md` if controller chooses to split) when a phase completes.

---

## v1 — bundle load, validation, raw timeline, four heuristics, markdown export

## Phase 0 — Tooling baseline, deps, configs

**Goal:** `packages/analyzer/` is a real workspace package; builds an empty SPA with router and Tailwind wired; vitest+jsdom runs; lint clean.

**Deliverables:**

- `packages/analyzer/package.json`:
  - `"type": "module"`
  - Scripts: `dev`, `build`, `preview`, `test`, `test:watch`, `typecheck`, `lint`
  - Dependencies: `@provenance/log-core`, `react`, `react-dom`, `react-router-dom`, `jszip`, `@tanstack/react-virtual`, `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`, plus the Radix primitives shadcn brings in (each added as components get scaffolded; initial: `@radix-ui/react-slot` for shadcn's Button)
  - DevDeps: `vite`, `@vitejs/plugin-react`, `@types/react`, `@types/react-dom`, `tailwindcss`, `postcss`, `autoprefixer`, `jsdom`, `@testing-library/react`, `@testing-library/jest-dom`
- `packages/analyzer/tsconfig.json` — extends `tsconfig.base.json`, `jsx: 'react-jsx'`, `lib: ['DOM', 'DOM.Iterable', 'ES2022']`, paths: `"@/*": ["./src/*"]` (shadcn's convention).
- `packages/analyzer/vite.config.ts` — react plugin, path alias for `@/`, `base: './'` for static hosting.
- `packages/analyzer/vitest.config.ts` — `environment: 'jsdom'`, setup file imports `@testing-library/jest-dom`.
- `packages/analyzer/tailwind.config.js` + `postcss.config.js` + `src/styles/globals.css` with `@tailwind base/components/utilities`.
- `packages/analyzer/components.json` — shadcn config (style: default, base color: neutral, css path, alias config).
- `packages/analyzer/src/lib/utils.ts` — `cn()` (clsx + tailwind-merge).
- `packages/analyzer/index.html` + `src/main.tsx` — mounts React with `<BrowserRouter>` wrapping `<App />`.
- `packages/analyzer/src/App.tsx` — top-level `<Routes>` with `/load`, `/overview`, `/timeline` stubs each rendering a placeholder.
- `packages/analyzer/src/components/ui/button.tsx` — first shadcn primitive, scaffolded; smoke-tested once.
- `packages/analyzer/src/__placeholder__/setup.test.tsx` — RTL render of `<App />` inside `<MemoryRouter>` asserting one placeholder text shows.
- Root `eslint.config.mjs` — add `packages/analyzer/src/**/*.{ts,tsx}` to the project glob; add `no-restricted-imports` forbidding `node:*`, `fs`, `path`, `worker_threads`, `crypto`.
- Root `package.json` `lint` script extended to cover `packages/analyzer/src`.
- Delete `packages/analyzer/src/.gitkeep`.

**Tests:** `npm run typecheck && npm run lint && npm run test && npm run build` all green.

**Exit gate:** `npm run dev --workspace=packages/analyzer` serves at `localhost:5173`. Navigating to `/load`, `/overview`, `/timeline` each renders a distinct placeholder. `npm run build --workspace=packages/analyzer` emits `dist/` static assets.

---

## Phase 1 — Bundle loader (pure, no UI)

**PRD refs:** §5.1, §5.3, §4.6.

**Goal:** turn a `Blob` into a typed in-memory `Bundle`. Pure functions everywhere except the unavoidable async ZIP read.

**Deliverables in `packages/analyzer/src/loader/`:**

- `unzip.ts` — `unzipBundle(input: Blob): Promise<Result<BundleFiles, LoaderError>>`. Uses `jszip`. Returns the raw text of `manifest.json`, the bytes of `manifest.sig`, and an array of `{sessionId, slogText, metaJson}` for every session pair found. Rejects with typed errors: `'not_a_zip' | 'missing_manifest' | 'missing_signature' | 'no_sessions' | 'orphaned_meta' | 'orphaned_slog' | 'unexpected_file'`.
- `parse-session.ts` — `parseSession(slogText, metaJson) → Result<ParsedSession, ParseError>`. Uses `log-core`'s `parseEntries` and `validateMetaShape`. Returns events, parsed meta, session_id, and `firstEvent: SessionStartEnvelope` (or `ParseError` if entry 0 isn't `session.start`).
- `parse-bundle.ts` — orchestrator: `loadBundle(blob, sourceFilename) → Promise<Result<Bundle, LoaderError | ParseError>>`. Aggregates sessions, sorts by `session.start.wall`, validates JCS manifest. Exposes:
  ```ts
  type Bundle = {
    manifest: BundleManifest;
    manifestSigHex: string;
    sessions: ParsedSession[]; // sorted oldest → newest
    sourceFilename: string;
    loadedAt: string; // ISO; for the export header
  };
  ```
- `types.ts` — types only.

**Tests:** ZIP missing manifest → typed error; valid ZIP round-trips; real fixture parses cleanly; corrupted NDJSON line → `ParseError` with line number.

**Exit gate:** unit tests pass on the real recorder-produced fixture. No browser code touched.

---

## Phase 2 — Validation pipeline (PRD §5.4)

**PRD refs:** §5.4, §5.1, §6.

**Goal:** `Bundle → ValidationReport`. Read by the overview view and by the `chain_broken` flag adapter.

**Deliverables in `packages/analyzer/src/validation/`:**

- `check-types.ts` — `ValidationCheck = { id, label, status: 'pass' | 'fail' | 'skipped', detail?, supportingSeqs? }` with the 8 PRD §5.4 checks enumerated.
- `verify-manifest-sig.ts` — Check 1. `manifest.sig` verifies against the most recent session's `session_pubkey`. Uses `@noble/ed25519.verifyAsync`.
- `verify-session-binding.ts` — Check 2. Each session's `session.start.data.manifest_sig` equals the bundle manifest's `manifest_sig` field.
- `verify-chain.ts` — Check 3. Thin wrapper around `log-core.validateChain` per session.
- `verify-seq.ts` — Check 4 (formally also in `validateChain`; surfaced separately so the report itemizes).
- `verify-monotonic-t.ts` — Check 5.
- `verify-monotonic-wall.ts` — Check 6 (clock.skew-aware; matches log-core's window interpretation, watch-item D5).
- `verify-doc-save-hashes.ts` — Check 7. Reconstructs expected content from prior `doc.change` + `paste` payloads since the previous save, compares hashes. Mismatches without a corresponding `fs.external_change` get flagged. (Pastes inline up to 4KB; pastes >4KB use the recorded sha256 — no reconstruction possible past the head/tail, so v1 marks these "indeterminate, attached to last save").
- `run-validation.ts` — orchestrator → `ValidationReport`.
- Check 8 is **skipped** in v1 (`status: 'skipped'`, detail explains course-staff cross-check input is required).

**Tests:** each check has unit tests against hand-built bundles (pass + fail cases). Orchestrator combinations. Perf: 10k-event bundle validates in <500ms.

**Exit gate:** real fixture validates as `pass`, or the report calls out precise failures.

---

## Phase 3 — Indices & per-file content reconstruction

**PRD refs:** §7.3, §7.4.

**Goal:** the data structures every downstream view reads from. Pure, no React.

**Known v2 extension point:** `reconstructFile` (final content only) becomes `reconstructFileWithProvenance` in Phase 12 (per-character "last touched by event" map for replay gutter + line hover). v1's reconstruction must be structured so v2 can layer provenance tracking on top without rewriting the apply-deltas loop.

**Deliverables in `packages/analyzer/src/index/`:**

- `event-index.ts`:

  ```ts
  type IndexedEvent = {
    sessionId: string;
    seq: number; // session-local
    globalIdx: number; // unique across the bundle
    wall: string;
    t: number;
    kind: EventKind;
    payload: unknown;
    file?: string;
  };

  type EventIndex = {
    bySeq: Map<string, IndexedEvent>; // key = `${sessionId}:${seq}`
    byKind: Map<EventKind, IndexedEvent[]>;
    byFile: Map<string, IndexedEvent[]>;
    bySessionId: Map<string, IndexedEvent[]>;
    ordered: IndexedEvent[]; // chronological across sessions
  };
  ```

- `build-index.ts` — `buildIndex(bundle): EventIndex`. Pure, O(N).
- `reconstruct-file.ts` — `reconstructFile(index, filePath, upToGlobalIdx?): { content, hashBySaveSeq: Map<string, string> }`. Applies `doc.change` deltas + `paste` payloads (inline only) to a running string. v2 swaps the implementation for the provenance-tracked version; the signature stays the same and gains optional fields.
- `stats.ts` — per-file aggregates `{ chars_typed, chars_pasted, chars_external_change_delta, idle_ms, active_ms, terminals_open_durations }`. Pure over `EventIndex`.

**Tests:** index a 10k-event stream, spot-check; reconstructFile against hand-known sequences; stats matches hand-computed.

**Exit gate:** unit tests pass; reconstruction matches every `doc.save.sha256` in the real fixture for files in `files_under_review`.

---

## Phase 4 — v1 heuristics

**PRD refs:** §7.4, §8 (v1 set: `large_paste`, `external_edits`, `low_typing_high_output`, `chain_broken`).

**Goal:** four deterministic heuristics over the indexed event stream. Each pure.

**Deliverables in `packages/analyzer/src/heuristics/`:**

- `types.ts`:
  ```ts
  type Severity = 'info' | 'low' | 'medium' | 'high';
  type Flag = {
    id: string;
    heuristic: string;
    title: string;
    severity: Severity;
    confidence: number; // 0..1
    supportingSeqs: string[]; // `${sessionId}:${seq}` keys
    description: string;
    detail?: Record<string, unknown>;
  };
  type Heuristic = {
    id: string;
    label: string;
    run(index: EventIndex, bundle: Bundle, config: HeuristicConfig): Flag[];
  };
  ```
- `large-paste.ts` — paste events with `text length ≥ 200` or `≥ 10 lines` (PRD §7.4 thresholds).
- `external-edits.ts` — one flag per `fs.external_change` without `explanation: 'formatter' | 'git'`. Coalesces bursts on the same file within ~2s.
- `low-typing-high-output.ts` — uses `stats.ts`. Ratio `chars_in_final_file / chars_typed > 3` triggers.
- `integrity-flags.ts` — adapter that converts failing `ValidationReport` check 3 (chain) into a `Flag`. (Same pattern reused in v2 for checks 1, 2, 6, etc.)
- `config.ts` — default thresholds, exported.
- `run-heuristics.ts` — `runHeuristics(index, bundle, validationReport, config?): Flag[]`. Sorted by severity desc then confidence desc.

**Tests:** each heuristic gets a positive + negative fixture. Snapshot test of the full suite against the real fixture.

**Exit gate:** suite produces a stable, expected flag list on the real fixture.

---

## Phase 5 — UI shell + bundle drop

**PRD refs:** §7.1, §7.2.

**Goal:** the user can drop a `.zip` and see _something_.

**Deliverables in `packages/analyzer/src/`:**

- `App.tsx` — `<Routes>` with `/load` (drop zone), `/overview`, `/timeline`. Redirects `/ → /load` when no bundle loaded; redirects `/load → /overview` when a bundle is loaded. Uses a `<RequireBundle>` route guard that redirects to `/load` if `BundleContext` is empty.
- `context/BundleContext.tsx` — provides `{ bundles, index, validationReport, flags, status }`. Provider sits between `<BrowserRouter>` and `<Routes>`. The type is plural-shaped from day 1 (`bundles: Bundle[]`) so Phase 11 only changes the loader, not the consumers.
- `views/load/LoadView.tsx` — full-screen drop zone + file picker fallback. Native HTML5 drag-and-drop.
- `views/load/LoadingPanel.tsx` — progress for unzip + per-session parse + index build + validation + heuristics. Driven by an event emitter on the loader.
- `views/load/ErrorPanel.tsx` — typed renderer for `LoaderError | ParseError` discriminated union; each variant gets a user-facing message and a suggested fix.
- `components/Header.tsx` — bundle filename, assignment id, session count, "Load different bundle" button (clears context, navigates to `/load`).
- `components/Layout.tsx` — top-bar + content slot used by overview/timeline.
- shadcn primitives scaffolded as needed: `button`, `card`, `badge`. (Add via `npx shadcn add` — one component per scaffold.)

**Tests:** drop event triggers loader; ErrorPanel parameterized over the union; BundleContext throws if read outside provider; route guard redirects when no bundle.

**Exit gate:** drop the test fixture, header populates, browser ends up on `/overview` (next phase fills it in).

---

## Phase 6 — Submission overview view

**PRD refs:** §7.2 ("Submission overview"), §7.4 (flag dashboard).

**Goal:** the landing view after loading a bundle.

**Deliverables in `packages/analyzer/src/views/overview/`:**

- `OverviewView.tsx` — composes the panels below.
- `ValidationReportPanel.tsx` — 8 checks, each with status + detail. Click a failing check → navigate to `/timeline` with a query param scrolling to the supporting seq.
- `SummaryStatsPanel.tsx` — session count, total active/idle time, file list, LOC added/removed.
- `FlagDashboardPanel.tsx` — sorted flag list with severity chips, confidence bar, supporting-event count. Click a flag → opens `HeuristicDetailDrawer`.
- `HeuristicDetailDrawer.tsx` — Radix Dialog (right-side drawer variant). Flag title, description, evidence, "Jump to raw timeline at seq X" per supporting event. (v2 Phase 15 will add a "Jump to replay" button alongside.)
- `Actions.tsx` — "Open Raw Timeline", "Export Findings (markdown)". Replay button **not present in v1**; added in Phase 13.
- shadcn primitives: `card`, `badge`, `dialog`, `scroll-area`, `progress`.

**Tests:** each panel renders the right counts/severities from a fixture; clicking a check/flag navigates correctly; snapshot of overall layout.

**Exit gate:** opening the real fixture shows: validation status, three or four sample flags, summary numbers that match hand counts.

---

## Phase 7 — Raw timeline view

**PRD refs:** §7.2 ("Raw timeline").

**Goal:** every event, filterable, virtualized, fast at 10k+ events.

**Deliverables in `packages/analyzer/src/views/timeline/`:**

- `TimelineView.tsx` — filter bar + virtualized list + event detail pane. Reads scroll-to seq from URL search params (`?seq=session-id:42`).
- `FilterBar.tsx` — multi-select for `kind` (Radix dropdown menu), file selector, time range (two text inputs initially; Radix slider in a polish pass).
- `EventList.tsx` — `@tanstack/react-virtual` row renderer. Row: seq, wall, kind chip, file, one-line payload summary, session-id chip (small).
- `EventDetail.tsx` — pretty-printed JSON of selected event + cross-links to surrounding events.
- `useFilteredEvents.ts` — pure hook; memoized per filter signature.
- shadcn primitives: `dropdown-menu`, `input`, `separator`.

**Tests:** filter logic as pure function (all combinations); virtualization renders the right node count for 10k events; deep-link via URL lands on the right event.

**Exit gate:** scrolling smooth on the real fixture; `kind='paste'` filter shows only paste events.

---

## Phase 8 — Findings export (markdown)

**PRD refs:** §7.5.

**Goal:** one button → self-contained `.md` for case files. PDF deferred to Phase 19.

**Deliverables in `packages/analyzer/src/export/`:**

- `findings-markdown.ts` — `renderFindings(bundle, validationReport, flags, opts): string`. Pure. Sections: header (assignment id, bundle filename, bundle sha256, generated-at), validation report, flag list with per-flag evidence, appendix with sample supporting event JSON.
- `download.ts` — `downloadAs(filename, blob)` helper using `URL.createObjectURL`.
- `views/overview/ExportMarkdownButton.tsx` — wires the above to the overview Actions panel.

**Tests:** snapshot against a known fixture (clock injected); filename includes assignment id and timestamp.

**Exit gate:** export the real fixture, open the `.md`, reads as a coherent integrity report.

---

## Phase 9 — Performance verification & integration tests

**PRD refs:** §7.3.

**Goal:** prove the budget; ship the end-to-end test.

**Deliverables in `packages/analyzer/test/`:**

- `perf/bench-load.test.ts` — synthetic 50 MB bundle (build programmatically: 100k events split across 5 sessions, chain valid). Assert load+parse+index <5s. Print p50/p95/p99.
- `perf/bench-heuristics.test.ts` — suite on the same synthetic bundle, budget <500ms total.
- `integration/load-and-validate.test.ts` — drop the real recorder fixture, run validation + heuristics, assert known-good results.
- `integration/regenerate-fixture.md` — operator doc.

**Exit gate:** all benches pass on a dev machine. CI runs `npm run test` cleanly. `npm run build --workspace=packages/analyzer` emits a working static site.

---

## Phase 10 — Static hosting build & v1 release

**PRD refs:** §7.1.

**Goal:** v1 ships. Analyzer can be hosted on any static host.

**Deliverables:**

- `packages/analyzer/README.md` — what it is, dev, build, host.
- Repo root `README.md` updated.
- Confirm `vite.config.ts` `base: './'` so SPA works under any URL prefix.
- `scripts/preview-fixture.sh` — runs `dev` and auto-opens the test fixture for 10-second demos.
- Tag `v1.0.0-analyzer` after merge.

**Exit gate:** `npm run build && npx serve packages/analyzer/dist` serves a fully working v1 analyzer.

---

# v2 — replay UI, full heuristic suite, cross-submission, PDF export

v2 starts after v1 has merged to `main` and been used against at least one assignment of real student bundles. The phase order is intentional: multi-bundle (Phase 11) is foundation for cross-submission heuristics (Phase 18); provenance-tracked reconstruction (Phase 12) is foundation for the replay UI (Phases 13–15); full heuristic suite (16, 17) and cross-submission (18) build on the established heuristics framework from Phase 4.

## Phase 11 — Multi-bundle loader + `/compare` route shell

**PRD refs:** §7.4 cross-submission heuristics, §8 v2.

**Goal:** the analyzer can load N bundles at once. UI surfaces them; cross-submission heuristics (Phase 18) consume them.

**Deliverables:**

- `loader/parse-bundle.ts` — extend to accept `Blob[]`. Returns `Bundle[]`.
- `context/BundleContext.tsx` — the `bundles: Bundle[]` field, which already existed in v1's type, now actually carries multiple. Indices and flags become per-bundle maps: `indicesByBundle: Map<bundleId, EventIndex>`, etc.
- `views/load/LoadView.tsx` — accept multi-file drop. "Load more bundles" button appears in the header once at least one is loaded.
- `views/compare/CompareView.tsx` — landing for cross-submission. v2 Phase 11 ships only the shell + a "select bundles" picker; the cross-submission heuristics fill it in at Phase 18.
- `App.tsx` — `/compare` route added; route guard requires `bundles.length >= 2`.

**Tests:** multi-bundle round-trip; per-bundle indices isolated; compare-view route guard.

**Exit gate:** drop two real fixtures, both appear in the header, both have independent overview/timeline views accessible via a bundle switcher.

---

## Phase 12 — Provenance-tracked file reconstruction

**PRD refs:** §7.2 (replay gutter coloring, hover attribution), §7.4 (`paste_is_solution` needs final-file vs paste comparison).

**Goal:** for every character in every file at every point in time, know which event last touched it.

**Deliverables in `packages/analyzer/src/index/`:**

- `reconstruct-file-provenance.ts` — `reconstructFileWithProvenance(index, filePath, upToGlobalIdx?): FileReplayState` where:
  ```ts
  type FileReplayState = {
    content: string;
    provenance: Uint32Array; // length === content.length; entries are globalIdx values
    kindByGlobalIdx: Map<number, 'typed' | 'paste' | 'external_change'>;
    hashBySaveSeq: Map<string, string>;
  };
  ```
  Builds incrementally: for each `doc.change` delta we splice both `content` and `provenance` together with the delta's globalIdx. For `paste` we splice the payload string. For `fs.external_change` with new full content available, we replace wholesale, attributing every char to the external-change event.
- `provenance-utils.ts` — helpers: `linesWithProvenance(state)`, `colorForGlobalIdx(state, gi)`, `lineLastTouchedAt(state, line)`.

**Performance:** the splice-with-attribution approach is O(deltas × avg_delta_size). On a 4-hour session this is ~50k deltas × ~5 chars = 250k ops, well under interactive budget. If we hit issues, swap the splice for a piece table later.

**Tests:** synthetic stream → expected content + provenance map; paste replaces only its target range; external_change attributes every char to the external event.

**Exit gate:** unit tests pass; final `content` and `hashBySaveSeq` match the v1 `reconstruct-file` output for every fixture file.

---

## Phase 13 — Replay UI: core editor + event applier + basic transport

**PRD refs:** §7.2 (replay view core).

**Goal:** a Monaco editor on `/replay/:sessionId` that plays events forward/backward with play/pause/step.

**Deliverables in `packages/analyzer/src/views/replay/`:**

- `ReplayView.tsx` — top-level layout: file tabs + Monaco + transport + event sidebar (sidebar in Phase 14). Routed at `/replay/:sessionId`; reads `?event=:globalIdx&speed=:n` query params and reflects state back into the URL.
- `MonacoMount.tsx` — lazy-loaded `<MonacoEditor />` (via `React.lazy`). Read-only.
- `useReplayEngine.ts` — state machine over the session's event stream. Methods: `play(speed)`, `pause()`, `step(n)`, `seek(globalIdx)`. Internally uses the Phase 12 reconstruction incrementally: `seek` jumps to a precomputed checkpoint (every 1k events) then steps forward.
- `TransportBar.tsx` — play / pause / step / scrub bar. Uses shadcn `slider`.
- `FileTabs.tsx` — one tab per file under review; clicking switches Monaco's model.
- shadcn primitives: `slider`, `tabs`, `tooltip`.

**Tests:** engine state machine as pure function (advance N events from state X → expected state Y); Monaco mount renders inside `<Suspense>`; URL ↔ state reflection.

**Exit gate:** open `/replay/:sessionId` on the real fixture, press play, see the file build itself char by char in Monaco; scrub the slider, content updates.

---

## Phase 14 — Replay UI: gutter overlay, hover attribution, sidebar event log

**PRD refs:** §7.2 (color-coded gutter, hover line attribution, scrolling sidebar event log).

**Goal:** visual signal for paste regions, external-change regions, and per-line attribution.

**Deliverables:**

- `views/replay/GutterDecorations.tsx` — Monaco `deltaDecorations` synced to the current `provenance` array. Paste regions = orange (CSS class added via Monaco decoration), external_change = red, typed = unstyled.
- `views/replay/LineHoverProvider.tsx` — Monaco `hoverProvider` showing "Last modified at t=…, kind=<paste|typed|external_change>, seq=…".
- `views/replay/EventSidebar.tsx` — virtualized event log that auto-scrolls to keep the current event in view as the engine advances.
- `views/replay/ColorLegend.tsx` — small legend in the corner.

**Tests:** decoration ranges match `provenance` array on synthetic states; hover content for a known line matches expected; sidebar scrolls when the engine advances past a sentinel.

**Exit gate:** play replay on the real fixture, see paste regions clearly highlighted orange; hover any line, see provenance.

---

## Phase 15 — Replay UI: speed control + jumps + deep links from overview/timeline

**PRD refs:** §7.2 (variable speed 0.25–32×, jump-to: next paste/external/flag/file-switch).

**Goal:** the replay UI is fully usable for triage.

**Deliverables:**

- `views/replay/SpeedControl.tsx` — Radix dropdown with preset speeds (0.25×, 0.5×, 1×, 2×, 4×, 8×, 16×, 32×); current speed in URL `?speed=`.
- `views/replay/JumpControls.tsx` — buttons: next paste, next external change, next flag, next file switch. Each button uses the index to find the next matching `globalIdx`, then `engine.seek(idx)`.
- `views/overview/HeuristicDetailDrawer.tsx` — extend the v1 drawer with a "Jump to replay at this moment" button per supporting event. Navigates to `/replay/:sessionId?event=:globalIdx`.
- `views/timeline/EventList.tsx` — every row gets a small "▶ replay here" button.
- Cross-cutting: every Flag in the v1 dashboard now has a working replay deep-link.

**Tests:** speed changes reflect in playback rate; jumps land on the right event for synthetic streams; deep links from the overview drawer arrive at the expected `globalIdx`.

**Exit gate:** open a v1 flag → click "Jump to replay" → replay opens at the flagged moment, paused, current line highlighted. End-to-end demo runs against the real fixture.

---

## Phase 16 — Full heuristic suite: process-shape (rest of PRD §7.4 process-shape table)

**PRD refs:** §7.4 process-shape (rows beyond v1).

**Goal:** add the rest of the process-shape heuristics.

**Deliverables in `packages/analyzer/src/heuristics/`:**

- `paste-is-solution.ts` — uses Phase 12 reconstruction. For each paste event, compute line-overlap (via `diff` package) between paste payload and the file's final state. >80% line overlap → flag.
- `mass-external-replacement.ts` — `fs.external_change` where new content shares <20% lines with old.
- `time-to-first-save-anomaly.ts` — `<30s` from `doc.open` to a `doc.save` containing `>500 chars` of new code.
- `idle-then-complete.ts` — idle `>10min` then a single save brings file from skeleton to complete (define "complete" as: passes the file's final hash; "skeleton" as: any prior state ≥ 50% smaller in chars).
- `no-intermediate-errors.ts` — file goes from empty to passing-tests with zero terminal commands exiting non-zero. Requires shell integration; degrades to `'skipped'` flag with reason when `shell_integration: false`.
- `paste-matches-known-source.ts` — accepts a course-supplied corpus (JSON: `[{name, hashes: string[], fuzzy_lines?: string[][]}]`); matches via hash or `diff` line ratio. v2 ships the mechanism; the corpus is course-staff's content (PRD §10 Q4 — surface this as an open question to the course staff before Phase 16 starts).
- `config.ts` — extended with new thresholds.
- `run-heuristics.ts` — register the new heuristics in the registry.

**Tests:** each heuristic has a positive + negative fixture; `paste_is_solution` against a known matching paste; corpus loader handles missing/malformed corpus gracefully.

**Exit gate:** suite produces stable flags on the real fixture; new flags appear in the dashboard.

---

## Phase 17 — Full heuristic suite: environment + integrity

**PRD refs:** §7.4 environment + integrity (rows beyond v1).

**Goal:** the rest of the §7.4 suite.

**Deliverables in `packages/analyzer/src/heuristics/`:**

- Environment:
  - `ai-extension-active.ts` — reads `ext.snapshot` + `ext.activate`; matches against `analyzer/config/ai-extension-list.json` (course-maintained list, committed). Informational severity.
  - `terminal-active-during-external-change.ts` — pairs `fs.external_change` events with overlapping terminal-open windows.
  - `extension-set-changed-mid-assignment.ts` — `ext.activate` after session start for a known AI tool.
  - `shell-integration-disabled.ts` — `terminal.open` payloads with `shell_integration: false` → informational flag.
- Integrity (mostly adapters over validation + recorder-emitted events):
  - Extend `integrity-flags.ts` to surface check 1 (sig), check 2 (binding), check 5 (`t` regression), check 6 (`wall` regression) as flags.
  - `clock-jumps.ts` — multiple `clock.skew` events or one with `delta_ms > 5min`.
  - `gap-in-heartbeats.ts` — `session.heartbeat` gaps >5min with no `session.end` / `session.start` pair between.
  - `multiple-sessions-overlap.ts` — two sessions with overlapping `[session.start.wall, session.end.wall]` ranges.
  - `extension-hash-mismatch.ts` — `bundle.manifest.extension_hash` not in `analyzer/config/known-good-extension-hashes.json`. Course-maintained allowlist; ships with the v2 build's expected hash.
- `analyzer/config/` — `ai-extension-list.json` (Copilot, Codeium, Continue, TabNine, Cursor extension IDs — initial seed), `known-good-extension-hashes.json` (one entry: the v1+v2 build's hash).

**Tests:** each heuristic has positive + negative fixture. Config files have schema-validation tests.

**Exit gate:** suite produces the full PRD §7.4 flag set on a fixture engineered to trigger each one.

---

## Phase 18 — Cross-submission heuristics

**PRD refs:** §7.4 cross-submission (v2+).

**Goal:** when multiple bundles are loaded, surface cross-bundle patterns.

**Deliverables in `packages/analyzer/src/heuristics/cross/`:**

- `paste-shared-across-students.ts` — for each paste with `length ≥ 100 chars`, group bundles whose pastes have the same sha256 (or >90% line overlap via `diff`). One flag per shared paste, listing the bundles + paste seqs.
- `editing-pattern-clone.ts` — sequence-similarity score (e.g., Jaccard over the kind-stream signature; or DTW over per-5-min activity buckets if Jaccard isn't discriminating). Score above threshold → flag.
- `views/compare/CompareView.tsx` — render the cross-submission flags as a table. Click a row → split-pane replay view (out of scope for v2 if it gets hairy; v2 ships side-by-side static states first, animated split-replay is a v2.1 polish).
- `runHeuristics` cross-mode: when `bundles.length >= 2`, runs both per-bundle and cross-bundle heuristics.

**Tests:** synthetic pair of bundles with a planted shared paste → flag fires; pair with no shared content → no flag; pattern-clone scoring on synthetic streams.

**Exit gate:** load two real fixtures with a deliberately-shared paste, see the cross-submission flag with both bundles linked.

---

## Phase 19 — PDF findings export with replay screenshots

**PRD refs:** §7.5.

**Goal:** the "Export Findings" button can produce a PDF including screenshots of key replay moments.

**Deliverables in `packages/analyzer/src/export/`:**

- `pdf-renderer.ts` — uses `jspdf` to lay out: cover page (assignment, bundle, hash), validation report, flag list, appendix.
- `screenshot.ts` — `screenshotReplayAt(sessionId, globalIdx): Promise<DataURL>`. Implementation strategy: mount a hidden Monaco instance off-screen, set state to the requested globalIdx, render decorations, use `html2canvas` to snap. Returns base64 PNG.
- `findings-pdf.ts` — orchestrator: for each flag of severity ≥ medium, screenshot its supporting events; embed each.
- `views/overview/ExportPdfButton.tsx` — wired to overview Actions, shows progress (screenshots can take a few seconds).

**Tests:** PDF byte length plausible; embedded images present; snapshot test of the renderer structure (PDFs are not byte-stable across runs, so test on structure/text content).

**Exit gate:** export the real fixture as PDF, open in a viewer, every flagged moment has a screenshot.

---

## Cross-phase guardrails (from CLAUDE.md)

- **Stop and ask on ambiguity.** Every phase has at least one judgment call; surface it in the phase-completion message rather than inventing.
- **No new dependencies mid-phase.** Anything beyond the §0 table needs a separate ask.
- **Diffs ≤ ~200 lines / ~5 files.** Phases likely to exceed and need splits when implemented: 5, 6, 13, 14, 16, 17.
- **No `Promise.all` over ordered reads.** Loader does per-session work in parallel, but final `sessions[]` is re-sorted by `wall` before exposing.
- **No watcher / interval / timer without a teardown.** All `useEffect` returns a cleanup; the replay engine's animation timer is canceled on unmount and on `seek`.
- **`log-core` boundary, mirrored for analyzer.** Phase 0 lands the ESLint rule forbidding `node:*` under `packages/analyzer/src/`. Web Crypto on `globalThis` is fine.

---

## What's not in this plan, on purpose

- **Threshold-calibration tooling** — was Phase 20 in an earlier draft; dropped because CS 61A doesn't have a labeled past-submission corpus to calibrate against. Heuristic thresholds in `heuristics/config.ts` are tunable in code by course staff. Revisit if/when a labeled set exists.
- **LLM-assisted review (PRD §7.6)** — v3. Depends on v2 being stable and on a privacy review.
- **Server-side bulk-review mode (PRD §8 v3)** — out of scope.
- **Submission-time server verification (PRD §8 v3)** — out of scope.
- **Non-VS-Code editor support (PRD §8 v3, NG6)** — out of scope.
- **Anything that requires the recorder to emit new event kinds.** The recorder is sealed at v1; if v2 heuristic work surfaces a gap (e.g., we want richer terminal data), that's a recorder change request, not analyzer scope.

---

## Open questions to resolve before / during implementation

### v1 phase open questions

1. **Library approvals** (§0 table): React 18, Vite, JSZip, jsdom, RTL, `@tanstack/react-virtual`, `react-router-dom@6`, `tailwindcss@3`, shadcn primitives (Radix-\* + cva + clsx + tailwind-merge + lucide-react). v2-only deps (`monaco-editor`, `@monaco-editor/react`, `diff`, `jspdf`, `html2canvas`) can be approved now or when v2 starts.
2. **Real test fixture provenance** (§0.6): we have three real `.slog`/`.slog.meta` files in `test-workspace/.provenance/`. They need to be sealed into a bundle ZIP via the recorder's `provenance.prepareSubmissionBundle` command (or programmatically reusing `commands/seal.ts`) and committed before Phase 1.
3. **Validation check 7 formatter allowlist** (Phase 2): default v1 allowlist is empty. Any external change without an `explanation` tag becomes a check-7 failure unless paired with `fs.external_change`. Course staff likely wants Black / autopep8 / Prettier on the list eventually — surface during Phase 2.
4. **Severity-to-color mapping** (Phase 6): default proposal info=gray, low=blue, medium=amber, high=red. Confirm with course staff before the dashboard ships.
5. **Hosting target** for the eventual built artifact (Phase 10): GitHub Pages? Course server? Default `base: './'` is safe.

### v2 phase open questions

6. **Course-maintained AI extension list** (Phase 17): the initial seed needs to be committed to `analyzer/config/ai-extension-list.json` before Phase 17. Course staff input required: which extension IDs count? Copilot, Codeium, Continue, TabNine, Cursor, Cody are the obvious ones; others?
7. **Known-good `extension_hash` list** (Phase 17): the analyzer ships with the hash of its own v2 build embedded. Anytime the recorder is rebuilt, the list needs updating. Operational process to clarify with course staff.
8. **Paste-corpus shape** (Phase 16, PRD §10 Q4): what does the course's known-source corpus look like? Past assignment solutions? Common Stack Overflow snippets? The corpus _content_ is course-staff's call; the _format_ is ours — default proposal: `JSON: [{name: string, source: string, hashes: string[]}]`.
9. **Cross-submission UI for editing-pattern-clone** (Phase 18): static side-by-side state vs animated split-replay. Default: side-by-side static for v2; animated split-replay is v2.1 polish.
10. **PDF page size + branding** (Phase 19): US Letter or A4? Course logo? Default: US Letter, no logo (case files are internal).
11. **D5 watch item from recorder** (validation check 6): if the analyzer's interpretation of "wall regression excused by clock.skew" needs to differ from log-core's wider window, decide during Phase 2.

---

## What future agents should do when resuming

1. Read this file top-to-bottom.
2. Read `.notes/progress.md` (or `.notes/analyzer-progress.md` once split out by the controller).
3. Check `git log --oneline analyzer-v1` or `analyzer-v2` to verify recorded commits match the phase tables.
4. Run `npm run typecheck && npm run lint && npm run test && npm run build` at repo root — should be all green before starting any new phase.
5. Open this plan's next pending phase.
6. Dispatch the implementer per `superpowers:subagent-driven-development`.
7. **Update progress notes** when a phase completes — flip status, add commit SHA, append new design decisions.
