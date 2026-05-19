# CLAUDE.md

Project conventions and standing instructions for Claude Code working in this repo. Read this fully before doing anything.

## What this is

Provenance: a CS 61A academic-integrity telemetry system. Two products in one repo:

- `packages/recorder/` — VS Code extension that logs editing activity to a tamper-evident file.
- `packages/analyzer/` — web app that reads those files (not built yet).
- `packages/log-core/` — shared log format, hash chain, event types. Used by both.

The full spec is at `docs/prd.md`. Section references in this file (e.g. "§4.2") refer to that document. **Read the relevant PRD section before implementing anything.** If the PRD and this file disagree, this file wins for code conventions; the PRD wins for product behavior.

## Working agreement

- **Stop and ask on ambiguity.** If a decision isn't covered by the PRD or this file, do not invent an answer. Ask. Inventing architecture is the single biggest failure mode on this project.
- **Stay in scope.** Touch only the files the current task requires. Do not opportunistically refactor. Do not "improve" things that weren't asked about. If you notice something that should change, mention it in your response; do not change it.
- **No new dependencies without asking.** Every `npm install` is a decision. Propose, justify, wait for approval.
- **No silent constraint softening.** If a test is failing and the obvious fix is to weaken the assertion, stop and explain. Tests encode requirements; loosening them is a product decision, not a coding decision.
- **Read before writing.** Before editing any file, read it. Before editing any module, read its tests.
- **Small diffs.** If a change touches more than ~200 lines across more than ~5 files, it's probably two changes. Split it.

## Architecture rules

- `log-core` has zero runtime dependencies on VS Code, Node-specific APIs, or the DOM. It's pure TypeScript that can run in any JS environment. This is non-negotiable — the analyzer (browser) and recorder (Node) both consume it.
- `recorder` depends on `log-core` and on `vscode`. Nothing else without approval.
- `analyzer` depends on `log-core` and on its UI stack. It does not depend on `recorder`.
- The log file format (§5) is the contract between recorder and analyzer. Changes to it require a version bump and explicit approval. Do not change the format to make an implementation easier.
- Events are append-only. There is no `update` or `delete` operation on a log. Anywhere.
- The hash chain (§5.2) is the foundation of integrity. Any code path that produces log entries goes through the same chaining function. There is exactly one such function and it lives in `log-core`.

## Code style

- TypeScript strict mode. No `any` except at FFI boundaries with a comment explaining why.
- `unknown` over `any` for untyped input. Validate and narrow.
- Discriminated unions over class hierarchies for event types.
- Pure functions over classes when there's no state to own. The hash chain is pure. The session writer is a class because it owns a file handle.
- No `Promise.all` over operations that must be ordered. Log writes are ordered.
- No background tasks without an explicit shutdown path. Every `setInterval`, every watcher, every async loop has a `dispose()`.
- Errors are values when expected (return a `Result<T, E>` or a discriminated union), exceptions when unexpected. Never swallow.

## Testing

- Vitest for unit tests. Co-located: `foo.ts` and `foo.test.ts` in the same directory.
- `@vscode/test-electron` for extension integration tests, in `packages/recorder/test/integration/`.
- Every PR-sized change ships with tests. New behavior gets new tests; bug fixes get a regression test that fails before the fix.
- For `log-core`: aim for full branch coverage. It's small and load-bearing.
- For event handlers: test the event-to-log-entry transformation as a pure function, separately from the VS Code wiring.
- Do not write tests that exercise VS Code APIs from unit tests. Mock at the seam.
- Tests must be deterministic. No `Date.now()` in assertions; inject a clock.

## Things that are easy to get wrong here

- **JCS canonicalization (§5.2).** Used for hashing. Whitespace, key ordering, and number representation all matter. Use a library; do not hand-roll.
- **The `doc.change` event firehose.** VS Code fires one per keystroke. The writer must buffer; handlers must be fast (<1ms p99 per §4.7).
- **Paste detection (§4.3).** Three signals, combined. Do not simplify to one signal without discussion.
- **External-change detection (§4.5).** The expected-content model is the source of truth; the on-disk hash is what we compare against. Easy to get the direction wrong.
- **Atomic writes.** Write-temp-then-rename. Never partial-write the live log file.
- **Clock handling.** Use a monotonic clock for `t` (relative to session start). Use wall clock for `wall`. Don't conflate.

## Things we are explicitly not doing

- Network calls from the recorder during a session (PRD NG2). The recorder is offline.
- Keystroke-level OS hooks. We use VS Code's document events, which are diff-grained, not key-grained.
- Recording outside an activated assignment workspace.
- ML/classifier-based code analysis. The v3 LLM-review feature reasons over process evidence, not code (PRD NG5).
- Obfuscating the extension. Students will read the source. Design assuming the protocol is public (PRD §6).

## Conventions for talking to me

- When you finish a task, summarize what you did, what you didn't do, and what you noticed but didn't change.
- If you make a non-obvious choice, explain it in the response. Don't bury it in a comment.
- If you used a library you weren't told to use, surface it. If you skipped a test you couldn't get to pass, surface it. Anything I'd want to know on review, lead with it.
- "Done" means: tests pass, types check, lint passes, diff is reviewable. Not "I wrote some code."

## Commands

- `npm run build` — build all packages
- `npm run test` — run all tests
- `npm run test:watch` — watch mode for current package
- `npm run lint` — eslint + prettier check
- `npm run typecheck` — tsc --noEmit across the workspace
- `npm run package:recorder` — build the VSIX for local install

If you need a command that doesn't exist, ask before adding it to `package.json`.

## Repo layout

```
provenance/
├── CLAUDE.md                  # this file
├── docs/
│   └── prd.md                 # product spec; the source of truth for behavior
├── packages/
│   ├── log-core/              # shared event types, hash chain, format
│   ├── recorder/              # VS Code extension
│   └── analyzer/              # web app (not yet built)
├── package.json               # workspace root
├── tsconfig.base.json
├── .eslintrc.cjs
└── .prettierrc
```

## When in doubt

Re-read the PRD section, re-read this file, and ask. The cost of a clarifying question is five minutes. The cost of building the wrong thing is a week.
