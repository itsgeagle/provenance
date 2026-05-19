# Provenance Recorder — Phased Implementation Plan

**Scope:** `packages/log-core` + `packages/recorder` only. Analyzer is out of scope; its needs constrain `log-core` (must run in browser; zero VS Code/Node-only deps) but no analyzer code is written here.

**Target end state:** PRD §8 v1 — "Recorder: activation, all event types in §4.2 except cross-session linking, paste detection, external-change detection, hash chain, bundle seal." Cross-session linking lands in Phase 9 anyway because it's cheap once meta/chain are real.

**Reading order:** every phase below references PRD sections. Re-read the section before writing the phase. Per CLAUDE.md, the PRD is product behavior and wins on behavior disputes.

---

## 0. Decisions that gate everything

CLAUDE.md forbids new dependencies without approval. The following are needed before Phase 1 can start and should be approved together:

| Dependency                   | Used for                                                                          | Proposed pick                                                                                               | Rationale                                                                                                              |
| ---------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| JCS (RFC 8785) canonicalizer | Hash-chain canonicalization (PRD §5.2)                                            | [`canonicalize`](https://www.npmjs.com/package/canonicalize)                                                | Single-purpose, no transitive deps, faithful to RFC 8785. CLAUDE.md explicitly says "use a library; do not hand-roll." |
| Ed25519 signing              | Manifest verify (PRD §4.1), per-session keypair (PRD §4.6), bundle sig (PRD §5.3) | [`@noble/ed25519`](https://www.npmjs.com/package/@noble/ed25519)                                            | Pure JS, audited, browser-and-node, no native build. Same lib works for analyzer later.                                |
| SHA-256 streaming            | doc.change hashing (PRD §4.7 — "incremental … running SHA-256 state per file")    | Node `crypto.createHash` in recorder; `@noble/hashes` in log-core if log-core ever needs to hash in-browser | Defer the log-core question until the analyzer ships. For now log-core takes a `HashFn` injected by the consumer.      |
| ZIP                          | Bundle seal (PRD §5.3)                                                            | [`jszip`](https://www.npmjs.com/package/jszip)                                                              | Same lib the analyzer will use; works on Node Buffers cleanly.                                                         |
| UUID                         | session_id (PRD §5.1)                                                             | `node:crypto.randomUUID()`                                                                                  | No new dep.                                                                                                            |

**Other up-front decisions (proposals; can be redirected):**

1. **Course public key for dev.** Generate a development keypair, store the public key as a TypeScript constant in `log-core` (or `recorder`), keep the private key out of the repo. Add a `tools/sign-cs61a-manifest.ts` script for producing test manifests.
2. **KDF for session-key encryption** (PRD §4.6: "encrypted with a key derived from the `.cs61a` manifest's signature"). HKDF-SHA256(manifest_sig, info=`"provenance-session-key-v1"`, salt=session_id). Symmetric algorithm: XChaCha20-Poly1305 via `@noble/ciphers` if approved, else AES-GCM via Node `crypto`.
3. **`machine_id`** (PRD §5.1). `sha256(os.hostname() + os.userInfo().username + per-session-salt)`. The salt prevents cross-assignment correlation.
4. **`extension_hash`** (PRD §6). Compute at session start over the unpacked extension `dist/` directory contents (sorted, JCS-ish concatenation). Store in `session.start.recorder.extension_hash`. Course-known-good value lives in the analyzer's verification config later.
5. **Worker-thread hashing** (CLAUDE.md "all hashing happens on a worker thread"). Defer to Phase 4. The streaming SHA-256 work is small per event; if we hit the 1ms p99 budget without a worker thread, we ship without it and document. If not, we add a `worker_threads` hasher.

If any of these are wrong, redirect before Phase 1.

---

## Phase 1 — `log-core`: types, canonicalization, hash chain

**PRD refs:** §4.2 (envelope + event taxonomy), §5.1 (header), §5.2 (chain rule), §6 (what tampering breaks).

**Goal:** the pure-TS foundation everything else builds on. Zero runtime deps on VS Code, Node-only APIs, or DOM (CLAUDE.md architecture rule).

**Deliverables in `packages/log-core/src/`:**

- `events.ts` — discriminated union for all event kinds in PRD §4.2 table, plus the v1-additive events `paste.anomaly`, `chain.broken`, `recorder.degraded`, `recorder.recovered_from_corruption` (PRD §4.3, §4.6, §4.8). Payloads typed per the PRD descriptions; `unknown` over `any` for any external blob.
- `envelope.ts` — `Envelope<T>` (`seq, t, wall, kind, data`) and `HashedEnvelope<T>` (`...envelope, prev_hash, hash`) types. Discriminated unions per CLAUDE.md style.
- `canonical.ts` — thin wrapper around the JCS library. Single export `canonicalize(value: unknown): string`.
- `hash-chain.ts` — single pure function:
  - `chainEntry(prevHash: string, entry: Envelope<unknown>, hashFn: HashFn): HashedEnvelope<unknown>` returning `entry` with `prev_hash` and `hash` fields populated using `sha256(prev_hash || canonicalize(entry without hash))` (PRD §5.2).
  - This is the **one** chaining function in the codebase (CLAUDE.md: "exactly one such function and it lives in `log-core`").
- `chain-validator.ts` — `validateChain(entries: HashedEnvelope[]): ValidationResult` returning either `{ ok: true }` or `{ ok: false, breakAt: seq, reason: 'hash_mismatch' | 'seq_gap' | 'time_regression' }`. Used at recorder startup (PRD §4.6) and analyzer load (PRD §5.4 steps 3–6).
- `result.ts` — `type Result<T, E> = { ok: true; value: T } | { ok: false; error: E }`. CLAUDE.md: "Errors are values when expected."
- `clock.ts` — `interface Clock { now(): number; wall(): string; }` plus a `SystemClock` and a `FixedClock` for tests. CLAUDE.md: "Tests must be deterministic. No `Date.now()` in assertions; inject a clock."
- `index.ts` — re-export the public surface.

**Tests (`*.test.ts` co-located):** full branch coverage (CLAUDE.md). Specifically:

- Canonicalization: key order, whitespace, unicode escapes, number representation, nested objects.
- Hash chain: empty chain, single entry, N-entry chain, deterministic across runs, breaks when any byte of any entry changes.
- Validator: clean chain, hash break at position k, seq gap, `t` regression, `wall` regression _without_ a `clock.skew` event, regression _with_ `clock.skew` (must pass).
- Result + Clock helpers.

**Exit gate:** `npm run typecheck && npm run test && npm run lint` clean. `log-core` imports nothing from `vscode`, `fs`, or `path` — enforce via ESLint rule (`no-restricted-imports`) on this package.

---

## Phase 2 — `log-core`: serialization + meta/bundle shapes

**PRD refs:** §4.6 (storage and format), §5.1 (header), §5.3 (bundle), §5.4 (validation).

**Goal:** define how a chain becomes bytes on disk, without owning a file handle. The recorder will own the handle; log-core owns the policy.

**Deliverables:**

- `ndjson.ts` — `serializeEntry(entry: HashedEnvelope): string` (produces one canonical-JSON line + `\n`) and `parseEntries(text: string): Result<HashedEnvelope[], ParseError>`. Used by recorder writer and by validator at startup.
- `buffer-policy.ts` — pure decision function: given `(bufferedBytes, lastFlushAtMs, nowMs)`, return whether to flush. Encodes PRD §4.7 "1s or 256 KB, whichever comes first." Recorder calls this; pure for easy testing.
- `meta.ts` — TypeScript types for the `.slog.meta` file (PRD §4.6):
  ```
  type SlogMeta = {
    format_version: '1.0';
    session_id: string;
    session_pubkey: string;          // base64 ed25519
    encrypted_session_privkey: string; // base64; encrypted under manifest-derived key
    checkpoints: Array<{ seq: number; hash: string; sig: string }>;
  };
  ```
  No I/O here — types and a `validateMetaShape` function only.
- `bundle.ts` — TypeScript types for `manifest.json` (PRD §5.3): assignment_id, session count, per-session `{session_id, slog_sha256, meta_sha256}`, `extension_hash`. Plus the validation report shape from PRD §5.4 that the analyzer will eventually emit.
- `cs61a-manifest.ts` — type + parser + signature-verify helper for the `.cs61a` manifest (PRD §4.1).

**Tests:** round-trip serialize → parse → validate; rejects malformed lines without crashing parser; meta shape validation; manifest signature verify against a known test keypair.

**Exit gate:** still no `fs`/`vscode` imports. Recorder can be started in Phase 3.

---

## Phase 3 — Recorder: activation gate + minimal session lifecycle

**PRD refs:** §4.1 (activation), §4.8 (course public key signature fails → don't activate), §5.1 (session.start payload).

**Goal:** launch the extension against `test-workspace`, see `.provenance/session-<uuid>.slog` appear with exactly two entries: a valid `session.start` (PRD §5.1) and a `session.end`.

**Deliverables in `packages/recorder/src/`:**

- `activation/manifest-loader.ts` — read `.cs61a` from `workspace.workspaceFolders[0]`, parse JSON, call `log-core`'s `verifyManifest`. Returns `Result<ValidManifest, ActivationError>`. **No recording at all if invalid** (PRD §4.1 "the extension does nothing").
- `activation/status-bar.ts` — non-dismissible status bar item "CS 61A: recording" (PRD §4.1). Disposed only on `deactivate`.
- `session/session-host.ts` — holds the active session: session_id, monotonic clock origin, current seq, last hash. Exposes `emit(envelope)` (no fs yet, just wires through to the writer in Phase 4).
- `session/recorder-context.ts` — gathers PRD §5.1 fields: `vscode.version`, OS via `process.platform`+`process.arch`, machine_id, extension version, full extension snapshot via `vscode.extensions.all`.
- `extension.ts` — replace the existing stub:
  ```
  activate():
    1. load + verify manifest. If invalid: silently return.
    2. mount status bar.
    3. start session-host, emit session.start.
    4. register deactivate to emit session.end and flush.
  ```
  Use a `disposables: vscode.Disposable[]` list and push everything; clear on deactivate. CLAUDE.md: "Every `setInterval`, every watcher, every async loop has a `dispose()`."

**Tests:** unit tests on the manifest loader and recorder-context (mocked `vscode` via test seam). Integration test in Phase 11; for now, manual smoke via the existing `.vscode/launch.json` "Run Recorder Extension" config.

**Exit gate:** launch in test-workspace, see status bar item + a 2-line `.slog` whose chain validates via `log-core`.

---

## Phase 4 — Recorder: writer, buffer, atomic writes, heartbeats

**PRD refs:** §4.6 (storage format + atomic writes), §4.7 (performance), §4.2 (session.heartbeat).

**Goal:** durable, append-only, buffered I/O. Heartbeats every 30s.

**Deliverables:**

- `io/session-writer.ts` — class owning the open file handle for the `.slog` file (CLAUDE.md: "The session writer is a class because it owns a file handle"). Responsibilities:
  - In-memory buffer of pending serialized lines.
  - Flush trigger via `log-core/buffer-policy` on every emit + on a 1s timer.
  - `fs.appendFile` writes; never rewrites earlier lines.
  - `dispose()` flushes synchronously (best-effort) and closes the handle.
- `io/atomic-write.ts` — write-temp-then-fsync-then-rename for the `.meta` file (PRD §4.6 + CLAUDE.md "easy to get wrong: atomic writes").
- `events/heartbeat.ts` — `setInterval` 30s, emits `session.heartbeat` with `{focused, active_file, idle_since_ms}` (PRD §4.2).
- `events/clock-watcher.ts` — periodic comparison between monotonic (`performance.now()`) and wall (`Date.now()`) deltas; if drift > threshold, emit `clock.skew`. CLAUDE.md: "Use a monotonic clock for `t`. Use wall clock for `wall`. Don't conflate."

**Tests:**

- Buffer policy with a fixed clock (already in Phase 1 but covered here too in writer integration).
- Writer flushes on size threshold, on time threshold, on dispose.
- Atomic-write helper: simulated crash between write and rename leaves no partial live file. (Use a temp dir; mock `rename` to throw on the second call.)

**Exit gate:** in test-workspace, after 90s idle, log contains session.start + 3 heartbeats + (on close) session.end, all chained correctly. Process memory steady.

---

## Phase 5 — Recorder: document events

**PRD refs:** §4.2 (event taxonomy), §4.7 (handlers <1ms p99), CLAUDE.md ("test the event-to-log-entry transformation as a pure function, separately from the VS Code wiring").

**Goal:** the typing-firehose, recorded faithfully.

**Deliverables:**

- `events/doc-events.ts` — pure transformers: `vscode.TextDocumentChangeEvent → DocChangeEnvelope`, etc. Take the raw VS Code event and the workspace-relative path; return the envelope. **No I/O, no global state in these functions.**
- `wiring/doc-wiring.ts` — the VS Code subscriptions that take events, call the pure transformer, and hand to the session host. This file is the "seam" CLAUDE.md describes — tests mock at this seam.
- Handlers for: `doc.open` (with full-content sha256 and line count), `doc.change` (range deltas + source classification = `'typed'` for now; paste detection rewrites this in Phase 6), `doc.save`, `doc.close`, `selection.change`, `focus.change`.
- `state/expected-content.ts` — per-file in-memory `ExpectedContent` model: applies each `doc.change` delta to a running content state and maintains a streaming SHA-256. This is the foundation for PRD §4.5. CLAUDE.md: "The expected-content model is the source of truth; the on-disk hash is what we compare against. Easy to get the direction wrong."

**Performance:** the handler path is `vscode event → transformer → `sessionHost.emit`→`writer.append-to-buffer`. None of these touches disk or hashes from scratch. CLAUDE.md budget: <1ms p99. We benchmark in Phase 11.

**Tests:** transformers as pure functions with synthetic `TextDocumentChangeEvent`s. Expected-content model: replay a sequence of deltas, hash matches the equivalent string-concat result. Wiring tested via integration in Phase 11.

**Exit gate:** typing in test-workspace produces one `doc.change` per VS Code change event with correctly-typed payloads.

---

## Phase 6 — Recorder: paste detection (the trickiest part)

**PRD refs:** §4.3 (the three-signal scheme), CLAUDE.md ("Paste detection. Three signals, combined. Do not simplify to one signal without discussion").

**Goal:** distinguish typing from pasting with high confidence; capture payloads per PRD policy.

**Deliverables:**

- `events/paste-classifier.ts` — pure function `classifyChange(change): 'typed' | 'paste_likely'`. Rule: single edit, `text.length >= 30`, zero deletions → `paste_likely`. (PRD §4.3 signal 1.)
- `wiring/paste-command-intercept.ts` — register a wrapping command for `editor.action.clipboardPasteAction`. On invocation, mark a "paste expected" flag scoped to (editor, time window ~50ms). Next `doc.change` that arrives within the window is labeled `paste_confirmed`. (PRD §4.3 signal 2.)
- `events/paste-reconciler.ts` — over a rolling window, compare counts: (handler-intercepted pastes) vs (large-single-insert classifications). If they diverge, emit `paste.anomaly`. (PRD §4.3 signal 3.)
- Payload policy: paste text ≤4096 bytes → inline; otherwise `{ head: first512, tail: last512, length, sha256 }`. (PRD §4.2 paste row + §4.3.)
- The recorder rewrites the `kind` from `doc.change` to `paste` for confirmed/likely pastes, with the full paste payload. **The non-paste `doc.change` still carries deltas verbatim.**

**Tests:**

- Classifier: 30-char insert → paste_likely; 29-char insert → typed; multi-edit composite → typed regardless of size.
- Reconciler: synthetic streams of (intercepts, large-inserts) producing/not producing anomaly events.
- Payload truncation correctness for 4KB boundary and a 1MB string.

**Exit gate:** in test-workspace, typing produces zero pastes; cmd-V of a 50-line block produces exactly one `paste` event with the 4KB truncation rule applied.

---

## Phase 7 — Recorder: external-change detection

**PRD refs:** §4.5 (the most important detection capability), CLAUDE.md ("the expected-content model is the source of truth; the on-disk hash is what we compare against").

**Goal:** detect file edits that bypass VS Code. This is the Claude-Code-in-a-terminal signal.

**Deliverables:**

- `events/external-change-detector.ts` — on `doc.save`, compute on-disk sha256 (streaming, async via `worker_threads` if Phase 4 added one; otherwise direct). Compare with `ExpectedContent.hash` from Phase 5.
  - Equal → emit `doc.save` with hash (PRD §4.2).
  - Not equal → emit `fs.external_change { path, old_hash: expected, new_hash: actual, diff_size }` _and_ update `ExpectedContent` to the new on-disk content (so subsequent edits chain from reality).
- `wiring/fs-watcher.ts` — `vscode.workspace.createFileSystemWatcher` over `files_under_review` from the manifest. On change events with no recent `doc.change` for the same file (within ~250ms tolerance), emit `fs.external_change`. Watcher is disposed in `deactivate`.
- `events/explanation-tags.ts` — a small allowlist scaffold for formatter / git events. If an external change was preceded (within ~2s) by a known formatter command (e.g., a saved-on-formatter run) or a `git.event`, the emitted `fs.external_change` carries `explanation: 'formatter' | 'git'`. PRD §4.5 says: "Anything we can't explain stays flagged."

**Tests:**

- `ExpectedContent.hash !== on-disk hash` → external_change emitted with correct old/new.
- `FileSystemWatcher` path: edit `test-workspace/hw.py` from a Node script while VS Code is unfocused, expect `fs.external_change`.
- Explanation-tag: simulate formatter run → tag attached.

**Exit gate:** in test-workspace, edit `hw.py` with a non-VS-Code editor while extension is running → `fs.external_change` lands in the log with old/new hashes and no `doc.change` predecessor.

---

## Phase 8 — Recorder: environment + cross-cutting events

**PRD refs:** §4.2 (terminal events, ext.snapshot, ext.activate, git.event, clock.skew), §4.4 (terminal capture mechanics).

**Goal:** the rest of the §4.2 event table that isn't tied to docs.

**Deliverables:**

- `wiring/terminal-wiring.ts` — subscribe to `window.onDidOpenTerminal`, `onDidCloseTerminal`, and (1.93+) `onDidExecuteTerminalCommand`. Each `terminal.open` event records `shell_integration: boolean` (PRD §4.4 — "every `terminal.open` event includes a `shell_integration: true|false` field"). When shell integration is on, emit `terminal.command` with command text + exit code. When off, only `terminal.open`/`terminal.close` with the gap noted.
- `wiring/extension-snapshot.ts` — `setInterval` 5min + at session start: emit `ext.snapshot` with `vscode.extensions.all.map(e => ({id, version, enabled}))` (PRD §4.2).
- `wiring/extension-activation.ts` — subscribe to `vscode.extensions.onDidChange` (or equivalent) and emit `ext.activate` per new activation.
- `wiring/git-wiring.ts` — use the Git extension API (`vscode.extensions.getExtension('vscode.git')?.exports`); subscribe to repository events; emit `git.event` for commit, checkout, etc.
- Clock-skew watcher already exists from Phase 4; verify thresholds are sane on a long run.

**Tests:** mockable wiring tested at unit level; manual smoke in test-workspace for terminal + extension list.

**Exit gate:** opening a terminal, installing/enabling an extension, running `git commit` in the integrated terminal — each produces the expected log line.

---

## Phase 9 — Recorder: session keypair, signed checkpoints, chain robustness

**PRD refs:** §4.6 (per-session ephemeral keypair, `seq → hash` checkpoints signed every N events; on startup validate chain), §4.8 (extension crash → new session, link via `prev_session_id`; corrupted log → quarantine + `recorder.recovered_from_corruption`), §5.1 (`session_pubkey`, `prev_session_id`).

**Goal:** make the chain useful for the analyzer's PRD §5.4 checks; survive crashes and corruption gracefully.

**Deliverables:**

- `crypto/session-keys.ts` — generate ephemeral ed25519 keypair at `session.start`; expose `session_pubkey`. Public key goes into the session.start payload. Private key encrypted under HKDF-SHA256(manifest_sig) using XChaCha20-Poly1305 (or AES-GCM) and stored in `.meta`.
- `crypto/checkpoint-signer.ts` — every N (proposed N=100) events, append a signed `{seq, hash, sig}` checkpoint to `.meta` via `atomic-write`.
- `startup/chain-recovery.ts` — on `activate`, if a prior `.slog` exists in `.provenance/`:
  1. Validate the existing chain via `log-core/chain-validator`.
  2. If valid and the session is dangling (no `session.end`), start a new session with `prev_session_id` set (PRD §4.8 extension crash row).
  3. If chain is broken, quarantine (rename `.slog → .slog.corrupt-<ts>`), start a new session, emit `recorder.recovered_from_corruption` with the quarantined path (PRD §4.8).
  4. If chain is broken mid-write of a still-active session (e.g., on startup we detect tampering of our own running log somehow), emit `chain.broken` with the break location and continue (PRD §4.6, §6 first bullet).
- `meta-writer.ts` consolidating §4.6 meta file responsibilities.

**Tests:**

- Sign/verify round-trip for checkpoints.
- HKDF + symmetric encrypt/decrypt round-trip for private key.
- Chain-recovery branch table (clean dangling, broken chain, missing file) under a temp dir.

**Exit gate:** kill the extension host mid-session; reopen workspace; new session.start carries the dead session's id in `prev_session_id`, dead session's `.slog` is intact and validates. Manually corrupt a byte → log is quarantined and a new session begins.

---

## Phase 10 — Recorder: bundle seal command

**PRD refs:** §4.6 (seal operation), §5.3 (bundle = ZIP of `.provenance/`), §5.4 (Analyzer-side checks we're feeding), §6 (`extension_hash` field).

**Goal:** the "Prepare Submission Bundle" command produces a single ZIP the analyzer can consume.

**Deliverables:**

- `commands/seal.ts` — VS Code command `provenance.prepareSubmissionBundle`:
  1. Stop accepting new events (or atomically snapshot the current `.slog`).
  2. Compute `manifest.json` per PRD §5.3:
     - `assignment_id`, `semester` from the `.cs61a` manifest.
     - `sessions: [{session_id, slog_sha256, meta_sha256, prev_session_id}]`.
     - `extension_hash` computed over the unpacked `dist/`.
     - `format_version: '1.0'`.
  3. Sign `manifest.json` with the most recent session's private key → `manifest.sig`.
  4. ZIP the `.provenance/` directory contents (slog + meta + manifest + sig) via `jszip` to `<workspace>/<assignment_id>-bundle-<ts>.zip`.
  5. Surface notification with the bundle path.
- `package.json` `contributes.commands` entry for the command and a status-bar action to invoke it.

**Tests:**

- End-to-end: start a session, type a few lines, run seal, unzip the result, validate via the same `log-core/chain-validator` and bundle-shape validators from Phase 2. (This is exactly what the analyzer will do; we're our own first consumer.)
- Manifest signature verifies under the session pubkey.

**Exit gate:** after a real session in test-workspace, running the command yields a ZIP that, when fed back through the validation pipeline, passes PRD §5.4 checks 1–6 (check 7 needs the file-hash cross-reference; check 8 is a course-staff cross-check that isn't ours).

---

## Phase 11 — Failure modes, performance verification, integration tests

**PRD refs:** §4.7 (perf budgets: <1ms p99, <50MB buffer, <20MB/4h), §4.8 (full failure table).

**Goal:** prove the budgets, harden the edges, ship the test harness.

**Deliverables:**

- `failure/disk-full-handler.ts` — on `ENOSPC` from writer, surface notification, emit `recorder.degraded`, switch the buffer to a small (e.g., 64KB) ring of "critical-only" events (session.start/end, fs.external_change, chain.broken). PRD §4.8 row 1.
- `test/integration/` under `packages/recorder/` using `@vscode/test-electron` (CLAUDE.md). Test scenarios:
  - Activation gate: valid manifest → status bar appears; tampered manifest → nothing happens.
  - Typing produces typed `doc.change`s.
  - Pasting produces `paste` event with payload.
  - Out-of-IDE edit produces `fs.external_change`.
  - Crash recovery: kill + reopen → `prev_session_id` set.
  - Seal produces a valid bundle.
- `test/perf/` synthetic benchmark: replay 10k synthetic doc.change events; assert p99 handler time, peak buffer size, total bytes written.
- `npm run package:recorder` confirmed to produce a working VSIX. (Script already declared in `package.json`; verify it builds.)

**Exit gate:** all of `npm run build && npm run typecheck && npm run lint && npm run test` pass at the repo root. VSIX builds. Manual smoke against test-workspace from a fresh clone walks the happy path end-to-end.

---

## Cross-phase guardrails (from CLAUDE.md)

- **Stop and ask on ambiguity.** Every phase has at least one open question; surface it in the response that completes the phase rather than inventing.
- **No new dependencies mid-phase.** Anything beyond the §0 list needs a separate ask.
- **Diffs ≤ ~200 lines / ~5 files** per PR. Phases 4, 7, and 9 are likely to exceed this and should be split when implemented — e.g., Phase 9 splits cleanly into `(a) session keypair + checkpoints` and `(b) chain recovery on startup`.
- **No `Promise.all` over ordered writes.** Append order is a correctness property.
- **No watcher / interval without a `dispose()`.** Heartbeats, snapshots, FS watcher, clock watcher, terminal subscriptions — each registered in the disposables array.
- **`log-core` boundary.** Phase 1 ends with an ESLint `no-restricted-imports` rule against `vscode`, `node:fs`, `node:path`, `node:worker_threads` in `packages/log-core/src/`. Keeps the analyzer's future portability constraint enforced.

---

## What's not in this plan, on purpose

- **Analyzer (PRD §7).** Out of scope per the user's instruction.
- **Cross-submission heuristics, replay UI, LLM review** (PRD §7.4 cross-submission, §7.2 replay, §7.6). All v2/v3.
- **Server-side verification** (PRD §8 v3).
- **Non-VS-Code editor support** (PRD §8 v3, NG6).
- **Course solution corpus for `paste_matches_known_source`** (PRD §10 open question 4).
- **Accessibility opt-in `accessibility_mode` field** (PRD §9). Worth recording the field name now so the format reserves it; surface as an open question in Phase 5.

---

## Open questions to resolve before / during implementation

(Carried from §0 above plus phase-specific.)

1. JCS/ed25519/ZIP/cipher library approvals (§0 table).
2. Course dev keypair generation + storage convention.
3. Exact KDF + symmetric algorithm for session privkey encryption (§0.2).
4. Worker-thread hashing — defer or build now? (§0.5, Phase 4).
5. PRD §10 Q1: how does `.cs61a` get into the workspace? Affects Phase 3 UX (silent vs friendly first-run).
6. PRD §10 Q2: multi-machine sessions — `prev_session_id` is self-asserted; do we want any cross-machine binding now or punt?
7. Heartbeat cadence and clock-skew threshold (PRD §4.2 says 30s; §4.2 `clock.skew` row doesn't define the threshold).
8. Reserve `accessibility_mode` field shape in session.start now or later (PRD §9).
9. Behavior when `files_under_review` from the manifest is empty or references files that don't exist yet (PRD §4.5 assumes the list is meaningful).
