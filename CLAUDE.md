# CLAUDE.md

Project conventions and standing instructions for Claude Code working in this repo. Read this fully before doing anything.

## What this is

Provenance: an academic-integrity telemetry and analysis system. Five workspaces in one repo, all currently shipped:

- `packages/log-core/` — pure-TS log format: event types, JCS canonicalization, hash chain, validator, ndjson serialization, bundle + manifest shapes, ed25519 manifest verification. Used by every other package.
- `packages/recorder/` — VS Code extension (**v1.1**) that records a tamper-evident `.provenance` log while a student works. All PRD §4 event types, three-signal paste detection, external-change detection, per-session signing keypair, signed checkpoints, chain recovery, bundle seal, disk-full degraded mode.
- `packages/shared/` — Zod schemas shared between `server` and `analyzer` so API contracts stay in sync.
- `packages/analyzer/` — React/Vite SPA (**v3**). Google OAuth login, semester switcher, cohort list, per-submission drill-in (overview / timeline / replay / validation), 24-slider heuristics tuning UI, cross-flags view, export panel. Also a standalone `/local` route that runs entirely in-browser (drop a `.zip`, no server).
- `packages/server/` — Node + Hono API server (**v3**). Postgres + Drizzle ORM, Google OAuth + sessions + API tokens, ZIP ingest pipeline (parse → match → heuristics → cross-flags), pg-boss job queue, OpenAPI 3.1 + Redoc, Prometheus metrics, retention sweep + session purge cron jobs. Object storage is S3-compatible (MinIO for dev).

The product specs live in `docs/`. The recorder spec is `docs/prd.md`; the analyzer/server spec is `docs/analyzer-v3-prd.md`. Section references like "§4.2" mean the recorder PRD unless the surrounding text says otherwise. **Read the relevant PRD section before implementing anything.** If a PRD and this file disagree, this file wins for code conventions; the PRD wins for product behavior.

## Working agreement

- **Stop and ask on ambiguity.** If a decision isn't covered by a PRD or this file, do not invent an answer. Ask. Inventing architecture is the single biggest failure mode on this project.
- **Stay in scope.** Touch only the files the current task requires. Do not opportunistically refactor. Do not "improve" things that weren't asked about. If you notice something that should change, mention it in your response; do not change it.
- **No new dependencies without asking.** Every `npm install` is a decision. Propose, justify, wait for approval.
- **No silent constraint softening.** If a test is failing and the obvious fix is to weaken the assertion, stop and explain. Tests encode requirements; loosening them is a product decision, not a coding decision.
- **Read before writing.** Before editing any file, read it. Before editing any module, read its tests.
- **Small diffs.** If a change touches more than ~200 lines across more than ~5 files, it's probably two changes. Split it.

## Architecture rules

- `log-core` has **zero** runtime dependencies on VS Code, Node-only APIs, or the DOM. Pure TypeScript that runs in any JS environment. An ESLint `no-restricted-imports` rule on `packages/log-core/**/*.ts` rejects `vscode`, `node:*`, `fs`, `path`, `worker_threads`, and `crypto` imports. Non-negotiable — both the browser analyzer and the Node server/recorder consume it.
- `recorder` depends on `log-core`, `vscode`, and a small fixed set of approved libraries: `@noble/ed25519`, `@noble/hashes`, `@noble/ciphers`, `canonicalize`, `jszip`. Nothing else without approval. The packaged VSIX is ESM (requires VS Code ≥ 1.94).
- `shared` depends only on `zod`. It's the type-safe API contract between server and analyzer — both import the same schemas.
- `analyzer` depends on `log-core`, `shared`, and its UI stack (React, Vite, TanStack Query, etc.). It does **not** depend on `recorder` or `server` source.
- `server` depends on `log-core`, `shared`, and its runtime stack (Hono, Drizzle, pg-boss, AWS S3 SDK, etc.). It does **not** depend on `recorder` or `analyzer` source.
- The log file format (recorder PRD §5) is the contract between recorder and analyzer. Pinned with test vectors in `packages/log-core/src/hash-chain.test.ts`. Changes require a version bump and explicit approval. Do not change the format to make an implementation easier.
- The HTTP API shape (`packages/shared/src/api-schemas.ts`) is the contract between server and analyzer. Treat schema changes the same way: explicit, versioned, with both ends updated in one diff.
- Events are append-only. There is no `update` or `delete` operation on a log. Anywhere.
- The hash chain (PRD §5.2) is the foundation of integrity. Any code path that produces log entries goes through the same chaining function. There is exactly one such function and it lives in `log-core`.

## Code style

- TypeScript strict mode. No `any` except at FFI boundaries with a comment explaining why.
- `unknown` over `any` for untyped input. Validate and narrow (Zod at HTTP/storage boundaries; discriminated unions internally).
- Discriminated unions over class hierarchies for event types.
- Pure functions over classes when there's no state to own. The hash chain is pure. The session writer is a class because it owns a file handle.
- No `Promise.all` over operations that must be ordered. Log writes are ordered. Ingest pipeline stages are ordered.
- No background tasks without an explicit shutdown path. Every `setInterval`, every watcher, every async loop, every pg-boss subscriber has a `dispose()` / graceful-shutdown hook.
- Errors are values when expected (return a `Result<T, E>` or a discriminated union), exceptions when unexpected. Never swallow.

## Testing

- Vitest for unit tests across every workspace. Co-located: `foo.ts` and `foo.test.ts` in the same directory.
- `@vscode/test-electron` for recorder integration tests, in `packages/recorder/test/integration/`.
- Server integration tests use **testcontainers** to spawn ephemeral Postgres + MinIO; they do not depend on `docker compose up`. Never point a test at the dev compose stack.
- Every PR-sized change ships with tests. New behavior gets new tests; bug fixes get a regression test that fails before the fix.
- For `log-core`: aim for full branch coverage. It's small and load-bearing.
- For event handlers: test the event-to-log-entry transformation as a pure function, separately from the VS Code wiring.
- Do not write tests that exercise VS Code APIs from unit tests. Mock at the seam.
- Tests must be deterministic. No `Date.now()` in assertions; inject a clock. Same for `Math.random()` and request IDs.

## Things that are easy to get wrong here

- **JCS canonicalization (recorder PRD §5.2).** Used for hashing and for manifest signatures. Whitespace, key ordering, and number representation all matter. Use the `canonicalize` library; do not hand-roll.
- **The `doc.change` event firehose.** VS Code fires one per keystroke. The writer must buffer; handlers must be fast (<1ms p99 per recorder PRD §4.7). There's a `npm run bench` to verify.
- **Paste detection (recorder PRD §4.3).** Three signals, combined. Do not simplify to one signal without discussion.
- **External-change detection (recorder PRD §4.5).** The expected-content model is the source of truth; the on-disk hash is what we compare against. Easy to get the direction wrong.
- **Atomic writes.** Write-temp-then-rename. Never partial-write the live log file.
- **Clock handling.** Use a monotonic clock for `t` (relative to session start). Use wall clock for `wall`. Don't conflate.
- **Server ingest ordering.** The pipeline is parse → match → heuristics → cross-flags. Stages are ordered and idempotent. A retry must produce the same flags and stats; tests assert this.
- **Retention sweep.** Deletes blobs only; DB rows are kept forever for audit. Don't add a "purge rows" path without explicit approval — see `docs/admin-guide.md` §6.
- **OAuth `hd` claim.** Authentication only succeeds when the Google ID token's `hd` matches `AUTH_ALLOWED_HOSTED_DOMAINS`. Do not loosen this; it's the only thing keeping randos off the analyzer.
- **Extension hash allowlist.** The analyzer validates each submission's recorder build hash against `packages/analyzer/src/heuristics/config/known-good-extension-hashes.json`. When the recorder ships a new VSIX, that list must be updated via `npm run update-hashes` (see README "Course staff: key & manifest workflow").

## Things we are explicitly not doing

- Network calls from the recorder during a session (recorder PRD NG2). The recorder is offline.
- Keystroke-level OS hooks. We use VS Code's document events, which are diff-grained, not key-grained.
- Recording outside an activated assignment workspace.
- ML/classifier-based code analysis. Any LLM-review feature reasons over process evidence (events, flags, timeline), not over student code (recorder PRD NG5).
- Obfuscating the extension. Students will read the source. Design assuming the protocol is public (recorder PRD §6).
- Deleting submission DB rows on retention. Only blobs are deleted; rows persist for audit (analyzer PRD / `docs/admin-guide.md` §6).

## Conventions for talking to me

- When you finish a task, summarize what you did, what you didn't do, and what you noticed but didn't change.
- If you make a non-obvious choice, explain it in the response. Don't bury it in a comment.
- If you used a library you weren't told to use, surface it. If you skipped a test you couldn't get to pass, surface it. Anything I'd want to know on review, lead with it.
- "Done" means: tests pass, types check, lint passes, diff is reviewable. Not "I wrote some code."

## Commands

Workspace-wide (run from repo root):

- `npm run build` — build all packages.
- `npm run test` — run all Vitest suites (~1200+ tests; server integration tests spin up ephemeral Postgres/MinIO via testcontainers, so Docker must be running).
- `npm run typecheck` — `tsc --noEmit` across the workspace.
- `npm run lint` — ESLint (only the `src/` trees of the five packages) + Prettier check.
- `npm run package:recorder` — build the dev-key VSIX for local install.
- `npm run update-hashes` — refresh the analyzer's known-good extension-hash allowlist (see README for required flags).

Per-workspace (run from root with `--workspace=packages/<name>`):

- `npm run dev --workspace=packages/server` — start API + worker (`tsx watch`, loads `.env`).
- `npm run dev --workspace=packages/analyzer` — Vite dev server on `:5173`.
- `npm run db:migrate --workspace=packages/server` — apply Drizzle migrations.
- `npm run test:integration --workspace=packages/recorder` — download VS Code and run real-Extension-Host tests.
- `npm run bench --workspace=packages/recorder` — SessionWriter perf benchmark (p99 << 1ms).
- `npm run build:prod --workspace=packages/recorder` — production VSIX with course public key embedded (requires `PROVENANCE_COURSE_PUBLIC_KEY_HEX`).

Dev infra:

- `docker compose up -d` — Postgres + MinIO for local server dev (see `compose.yaml`). Not used in tests.

If you need a command that doesn't exist, ask before adding it to `package.json`.

## Repo layout

```
provenance/
├── CLAUDE.md                              # this file
├── README.md                              # quickstart, status table, key/manifest workflow
├── compose.yaml                           # dev-only Postgres + MinIO
├── docs/
│   ├── prd.md                             # recorder product spec
│   ├── recorder.md                        # recorder security model + threat notes
│   ├── analyzer-v3-prd.md                 # analyzer + server product spec
│   ├── analyzer-v3-design.md              # analyzer v3 design doc
│   ├── analyzer-v3-implementation-plan.md # 26-phase build plan
│   ├── analyzer-implementation-plan.md    # older analyzer plan (kept for history)
│   ├── implementation-plan.md             # original repo-wide plan
│   ├── admin-guide.md                     # hosting, OAuth, retention, backups, restore drill
│   ├── api-quickstart.md                  # Python + curl examples for the v3 API
│   └── heuristics.md                      # heuristics catalogue
├── packages/
│   ├── log-core/        # event types, hash chain, format (pure TS)
│   ├── recorder/        # VS Code extension (v1.1)
│   ├── shared/          # Zod API schemas shared by server + analyzer
│   ├── analyzer/        # React/Vite SPA (v3)
│   └── server/          # Node + Hono API server (v3)
├── tools/               # dev scripts: course-keypair generation, manifest signing
├── scripts/             # repo-level scripts (e.g. update-extension-hash-allowlist.mjs)
├── test-workspace/      # sample student workspace for dev + integration tests
├── package.json         # npm workspace root
├── tsconfig.base.json
├── eslint.config.mjs
└── .prettierrc
```

## When in doubt

Re-read the PRD section, re-read this file, and ask. The cost of a clarifying question is five minutes. The cost of building the wrong thing is a week.
