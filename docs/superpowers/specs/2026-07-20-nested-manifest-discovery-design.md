# Nested manifest discovery + concurrent multi-assignment recording — VS Code recorder

**Repo:** `provenance` monorepo, `packages/recorder/` (provcode, VS Code extension v1.1)
**Date:** 2026-07-20
**Status:** Approved design, ready for implementation plan (superpowers SDD)
**Sibling specs:** JetBrains (`provenance-jetbrains-recorder`), Neovim (`provenance-neovim-recorder`) — same feature, editor-specific mechanics.

## Problem

The recorder only activates when the assignment folder (the one holding `.provenance-manifest`) is opened as the **exact** workspace root. It takes `vscode.workspace.workspaceFolders[0]`, reads the manifest **only** at that folder's root (non-recursive), and scopes recording to that single root. Students keep their assignments nested inside a larger course folder (e.g. `61a/cats/`, `61a/hog/`). When they open `61a/`, no manifest exists at the top level, so the recorder silently records nothing. This was the single most common piece of TA/student friction in the pilot.

## Goals

- A student can open a **parent** folder (e.g. `61a/`) that contains one or more assignment subfolders, and recording activates for each discovered assignment automatically.
- Multiple assignments under the opened tree record **concurrently, each as its own independent session**, writing into its **own** `<assignmentRoot>/.provenance/` directory.
- At seal time, when more than one assignment has recorded, the student **selects which assignment** to bundle.
- Terminal/git events are attributed **by path** to the owning assignment session; dropped when no assignment owns them.
- All existing integrity guarantees are preserved.

## Non-goals

- No change to the log file format, manifest schema, JCS canonicalization, hash chain, or manifest signing/verification. (Format is the cross-recorder contract.)
- No recording of files outside every assignment root (the privacy invariant stays).
- No multi-root reconciliation hacks (the "cats as folder[0]" workaround is explicitly rejected — it over-records).

## Locked decisions (from design discussion)

1. **Track separately.** N verified manifests → N concurrent sessions. A session is already cryptographically bound to a single manifest signature, so N manifests naturally means N sessions.
2. **Per-assignment `.provenance/`.** Each session writes to `<assignmentRoot>/.provenance/`, derived from the manifest's directory — not one shared dir.
3. **Seal selector.** When >1 session is active, the seal command prompts the student (QuickPick) for which assignment to bundle. Exactly one active → no prompt (current behavior).
4. **Terminal/git attribution = by path.** Route a terminal command to the session whose assignment root contains the terminal's cwd; git events to the session whose root contains the repo/operation path. If no assignment root owns it, **drop** the event.
5. **Nearest-enclosing ownership.** A file belongs to the session of the **nearest ancestor** directory that has a verified manifest. Sibling assignments never overlap; a nested manifest (unusual) wins over its ancestor for files beneath it.

## Current architecture (seams to change)

| Concern                                                  | Location                                                  |
| -------------------------------------------------------- | --------------------------------------------------------- |
| Activation events (root-only, non-glob)                  | `packages/recorder/package.json:23-26`                    |
| First-folder selection (`workspaceFolders[0]`)           | `src/extension.ts:597-606`                                |
| Manifest load, root-only, non-recursive                  | `src/activation/manifest-loader.ts:48-88` (esp. `:55-56`) |
| Manifest file names                                      | `manifest-loader.ts:34`                                   |
| Silent no-op on missing/invalid manifest                 | `src/extension.ts:190-205`                                |
| `.provenance/` dir from single root                      | `src/extension.ts:215-217`                                |
| In-scope filter (`isRecordable`)                         | `src/wiring/doc-wiring.ts:205-211`                        |
| Out-of-workspace detection (`asRelativePath` === fsPath) | `doc-wiring.ts:149-168`                                   |
| `files_under_review` external-change watchers            | `src/wiring/fs-watcher.ts:86-88`                          |
| Assignment identity from manifest                        | `src/session/recorder-context.ts:89-92`                   |
| Seal stamps assignment/semester                          | `src/commands/seal.ts:177-179`                            |
| Session-key encryption bound to manifest sig             | `src/extension.ts:297-301`                                |

(Terminal/git emit seams are not enumerated here — the implementation plan must locate them and apply the by-path routing rule.)

## Design

### 1. Discovery

- **Activation event:** change `workspaceContains:.provenance-manifest` / `provenance-manifest` to glob forms that match nested manifests (`workspaceContains:**/.provenance-manifest`, `workspaceContains:**/provenance-manifest`). This makes VS Code activate the extension when a manifest exists anywhere under an opened folder.
- **Scan:** on activation, iterate **all** `workspace.workspaceFolders` (support multi-root), and for each, recursively find directories containing a manifest file. The walk must be **bounded and cheap**: skip `node_modules`, `.git`, `.provenance/`, and other obvious heavy/ignored dirs; cap depth to a sane limit; use async I/O. Prefer `workspace.findFiles('**/{.provenance-manifest,provenance-manifest}', <exclude glob>)` over a hand-rolled walk where possible.
- **Verify each** discovered manifest with the existing `loadAndVerifyManifest` logic (ed25519 vs embedded course key). Skip any that fail — a bad manifest must not block the others.
- **Dedupe** by resolved assignment root (a directory yields at most one session).
- **React to changes:** re-scan on `workspace.onDidChangeWorkspaceFolders`, and start/stop sessions when a manifest appears/disappears (best-effort; a manifest is normally static during a session).

### 2. Session registry (one → many)

Introduce a `SessionRegistry` that owns a `Map<assignmentRoot, ActiveSession>`. Each `ActiveSession` bundles what today is a single global session: its own `RecorderContext` (bound to that manifest's signature), its own writer, its own `.provenance/` dir, its own `files_under_review` model, its own fs-watchers. Everything that currently derives from the single `workspaceFolder` becomes per-session state parameterized on the assignment root. Every session has an independent `dispose()`; extension deactivate disposes all.

### 3. Scoping / event routing

- Replace the single-root `isRecordable` with a **router**: given a document URI, find the session whose assignment root is the **nearest ancestor** of the file; if none, drop the event. The existing `.provenance/` and manifest-file exclusions apply per session.
- Each `doc.open/change/save/close/selection` event is delivered to **exactly one** session. No event may leak across sessions or be recorded by more than one.
- Preserve the current out-of-workspace semantics for files under no assignment root: not recorded.

### 4. Seal selector

- The `provenance.prepareSubmissionBundle` command: if exactly one active session, seal it (unchanged). If more than one, show a `window.showQuickPick` of active assignments (label by `assignment_id` + folder) and seal the chosen one. If a specific editor/file context is available, default the pick to the assignment owning the active editor.
- Each seal continues to produce a self-contained signed bundle from that session's `.provenance/`.

### 5. Terminal/git routing (by path)

- For terminal events: resolve the terminal's cwd; route to the session whose assignment root contains that cwd; if none, drop.
- For git events: resolve the operation's repo/working path; route to the owning session; if none, drop.
- This replaces any current "emit to the one global session" wiring. The router is the single source of truth for attribution.

## Integrity invariants (must hold)

- Log format, manifest schema, JCS, hash chain, and signing are untouched.
- Each session's events chain independently and are bound to that session's manifest signature (no shared chain across assignments).
- No file outside all assignment roots is ever recorded.
- No event is recorded by more than one session.
- A manifest that fails verification produces no session and does not affect others.

## How we confirm it works (acceptance criteria)

New/updated unit tests (Vitest, co-located), mocking the VS Code seam:

1. **Discovery:** opening a parent folder with two nested manifests yields two sessions; a manifest at the opened root still yields one; a folder with no manifest yields none; a failing-signature manifest is skipped while a sibling valid one still activates.
2. **Routing:** an edit to `61a/cats/x.py` is recorded by the cats session only; an edit to `61a/hog/y.py` by the hog session only; an edit to `61a/notes.md` (under no manifest) is dropped; nearest-enclosing manifest wins for a nested case.
3. **Per-`.provenance/`:** each session writes to its own `<root>/.provenance/`; no cross-writes.
4. **Seal selector:** one active → no prompt; two active → prompt, and sealing the chosen assignment bundles only that session.
5. **Terminal/git:** a command with cwd under cats routes to cats; a command with cwd at the parent (owned by no assignment) is dropped.
6. **Regression:** the existing single-assignment happy path (open the assignment folder directly) behaves exactly as before.

"Works" = `npm run build`, `npm run typecheck`, `npm run lint`, and `npm run test` all green from repo root, with the new tests included. Integration tests under `packages/recorder/test/integration/` updated if activation/seal wiring they exercise changed.

## Rollout

- Feature branch off `main` (e.g. `feat/nested-manifest-discovery`). This spec is the branch's first commit.
- Small, reviewable commits per SDD task. Do not merge or open a PR — stop after verification and report.
