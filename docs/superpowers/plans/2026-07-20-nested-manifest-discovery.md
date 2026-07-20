# Nested Manifest Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the recorder discover `.provenance-manifest`/`provenance-manifest` files nested anywhere under the opened workspace folder(s), run one independent recording session per verified manifest (each writing to its own `<assignmentRoot>/.provenance/`), route every doc/terminal/git event to exactly one owning session by nearest-ancestor path, and add a seal-time assignment picker when more than one session is active.

**Architecture:** Extract the existing ~400-line single-session `activateImpl()` body in `packages/recorder/src/extension.ts` into a reusable per-assignment-root `startSession()` function in a new `session/session-registry.ts`. A new `SessionRegistry` owns `Map<assignmentRoot, ActiveSession>`. A new pure `session/session-router.ts` resolves "which assignment root owns this path?" via longest-prefix (nearest-ancestor) matching. `extension.ts`'s `activate()` becomes: discover manifests (new `activation/manifest-discovery.ts`, built on `vscode.workspace.findFiles`) → verify each → `startSession()` per verified manifest → register in `SessionRegistry`. Every wiring module that emits path-scoped events (doc, fs-watcher, terminal, git) keeps its existing "one instance per session" shape but gains an ownership filter sourced from the router, so exactly one instance's filter passes for any given path/cwd. The seal command becomes a QuickPick over `SessionRegistry`'s active sessions when more than one exists.

**Tech Stack:** TypeScript strict, VS Code Extension API (`vscode.workspace.findFiles`, `vscode.window.showQuickPick`, `vscode.RelativePattern`), Vitest (co-located unit tests, no `@vscode/test-electron` in unit tests), `@provenance/log-core` (unchanged — no format/schema/signing changes).

## Global Constraints

- No change to the log file format, manifest schema, JCS canonicalization, hash chain, or manifest/bundle signing (spec Non-goals; repo CLAUDE.md: "the log file format is the contract between recorder and analyzer... changes require a version bump and explicit approval"). Every task below must leave `@provenance/log-core`'s public surface untouched.
- No recording of any file outside every discovered assignment root (spec Non-goals / privacy invariant).
- No new npm dependencies. Discovery uses `vscode.workspace.findFiles` (built-in VS Code API), never the `glob` npm package (that's a devDependency used only by the integration-test build, not a runtime dependency of the extension).
- The recorder's approved dependency set is unchanged: `@noble/ciphers`, `@provenance/log-core`, `jszip`, plus `vscode` and Node built-ins. Do not add anything without asking.
- Every session's events chain independently (its own `SessionHost`, own `SessionWriter`, own `.slog`) and bind to that session's own manifest signature — no shared chain across assignments (spec integrity invariant).
- No event may be recorded by more than one session, and no event may leak to a session that doesn't own it (spec integrity invariant + acceptance criteria #2).
- A manifest that fails verification produces no session and does not affect any other discovered manifest (spec integrity invariant + acceptance criteria #1).
- Small, reviewable commits per task (repo CLAUDE.md: ~200 lines / ~5 files max per commit — split further if a task would exceed that). Conventional-commit messages, `git commit --no-gpg-sign`, no `Co-Authored-By` trailer, always stage with explicit pathspecs.
- Vitest co-located tests (`foo.ts` + `foo.test.ts` in the same directory), per repo CLAUDE.md. Mock the VS Code seam; never exercise real VS Code APIs from a unit test — that's what `packages/recorder/test/integration/` (real Extension Host, unchanged in this plan except where a task says otherwise) is for.
- Tests must be deterministic: inject the clock (`FixedClock` from `@provenance/log-core`), never assert on `Date.now()`/`Math.random()`/real UUIDs directly.

## Plan-level decisions (spec left these open; locked here)

1. **`loadAndVerifyManifest`'s parameter type is widened, not replaced.** Its first parameter changes from `vscode.WorkspaceFolder` to the minimal structural type `{ uri: { fsPath: string } }`. A `WorkspaceFolder` already satisfies this shape, so every existing call site keeps compiling unchanged (TypeScript structural typing — this is a type *widening*, not a breaking change). Discovery then calls it with `{ uri: { fsPath: candidateDir } }` for any nested directory.
2. **Ownership routing is pure and centralized in one new module** (`session/session-router.ts`), exporting `resolveOwnerRoot(filePath: string, assignmentRoots: readonly string[]): string | null`. This is unit-tested in total isolation from VS Code. Every wiring module (doc, fs-watcher via its base path, terminal, git) is handed a per-session `isOwnedByThisRoot(path: string): boolean` predicate that the caller (session-registry / extension.ts) builds by calling `resolveOwnerRoot(path, allRoots) === thisSessionsRoot`.
3. **Uniform "N instances, each self-filters" architecture across doc/terminal/git wiring**, matching the spec's existing "each `ActiveSession` bundles ... its own fs-watchers" design (spec §2). Concretely: `startDocWiring`, `startFsWatcher`, `startTerminalWiring`, and `startGitWiring` are each still instantiated **once per session** (as today, for one session), but each now takes an `isOwnedByThisRoot` predicate and drops events that fail it. VS Code delivers the same underlying event (e.g. `onDidOpenTerminal`) to every registered listener regardless of how many extensions/instances subscribed, so N per-session instances subscribing to the same global VS Code event and self-filtering is correct and requires no new central dispatcher. This keeps every wiring module's existing shape and public API almost unchanged (additive parameter only), which is the smallest possible diff. The alternative (one shared listener + central dispatch table) would be a larger, riskier rewrite of already-tested modules for no behavioral benefit at the session counts this feature targets (a handful of concurrently open assignments, not thousands).
4. **Assignment-relative paths, not `vscode.workspace.asRelativePath`.** Today, `workspaceFolder` and "assignment root" are always the same directory, so `vscode.workspace.asRelativePath(uri)` (which resolves relative to whichever *opened* workspace folder contains the file) happens to already produce assignment-root-relative paths. Once a workspace folder can contain **multiple** nested assignment roots, `asRelativePath` would return paths relative to the outer opened folder (e.g. `cats/hw.py`), not the assignment root (`hw.py`) that `files_under_review` entries, `.slog` path fields, and the analyzer's bundle contract all assume. This plan introduces a small pure helper, `makeAssignmentRelativePath(assignmentRoot: string): (fsPath: string) => string`, computed via `node:path.relative`, and threads it through the existing `WorkspaceLike` seam (`doc-events.ts`'s `{ asRelativePath }` interface is unchanged in shape — only the *production implementation* passed to it changes, per session). This preserves the log format's existing path semantics unchanged for the regression case (workspace folder == assignment root ⇒ `path.relative(root, fsPath)` and `vscode.workspace.asRelativePath` agree) while making the nested case correct.
5. **Status bar stays global, not per-session.** The spec does not ask for per-assignment status bar UI, and multiplying it is pure scope creep. One status bar item is still mounted once per extension activation (as today); it is not touched by this plan beyond continuing to be created once regardless of session count.
6. **`sealBundle`'s `workspaceFolder: vscode.WorkspaceFolder` parameter is renamed to `assignmentRoot: string`.** The function only ever reads `.uri.fsPath` off it (for resolving `filesUnderReview` and as the default output directory) — never anything else on the `WorkspaceFolder` shape. Renaming to a plain string is a mechanical, compatible simplification and correctly scopes sealing to the *assignment* root (which, in the nested case, is a subdirectory of the opened workspace folder) rather than the outer opened folder.
7. **Workspace-folder-change reactivity is scoped narrowly.** The spec's Design §1 mentions re-scanning on `workspace.onDidChangeWorkspaceFolders` and starting/stopping sessions "best-effort." The six numbered acceptance-criteria groups do not test this path directly. This plan implements: on a workspace-folder-added event, re-run discovery and start sessions for any newly-discovered, previously-unknown roots; on a workspace-folder-removed event, dispose any `ActiveSession` whose `assignmentRoot` is no longer contained by any currently-open workspace folder. Both are folded into Task 6 (the registry/wiring task) rather than a separate task, since they reuse Task 6's own `SessionRegistry` methods directly.

---

## File Structure

- `packages/recorder/src/activation/manifest-loader.ts` — **modify**: widen `loadAndVerifyManifest`'s first parameter type (decision 1).
- `packages/recorder/src/activation/manifest-discovery.ts` — **create**: `discoverManifests()` — walks all open workspace folders via `vscode.workspace.findFiles`, verifies each candidate, returns `{ root: string; manifest: Manifest }[]` plus skip diagnostics.
- `packages/recorder/src/activation/manifest-discovery.test.ts` — **create**.
- `packages/recorder/src/session/session-router.ts` — **create**: pure `resolveOwnerRoot()` nearest-ancestor resolver.
- `packages/recorder/src/session/session-router.test.ts` — **create**.
- `packages/recorder/src/session/assignment-relative-path.ts` — **create**: `makeAssignmentRelativePath()` pure helper.
- `packages/recorder/src/session/assignment-relative-path.test.ts` — **create**.
- `packages/recorder/src/session/session-registry.ts` — **create**: `ActiveSession` type, `startSession()` (the extracted per-root activation body), `SessionRegistry` class.
- `packages/recorder/src/session/session-registry.test.ts` — **create**.
- `packages/recorder/src/extension.ts` — **modify**: `activate()`/`deactivate()`/`activateImpl` rewritten to use discovery + `SessionRegistry`; seal command becomes a QuickPick over active sessions.
- `packages/recorder/src/activation/activation.integration.test.ts` — **modify**: keep the existing single-manifest assertions passing against the new entrypoint shape; extend with multi-session cases (or split into a new `extension.test.ts` — Task 6 decides based on resulting file size).
- `packages/recorder/src/wiring/doc-wiring.ts` — **modify**: add `isOwnedByThisRoot` + assignment-relative-path plumbing to `DocWiringDeps`.
- `packages/recorder/src/wiring/doc-wiring.test.ts` — **modify**: add ownership-filter cases.
- `packages/recorder/src/wiring/fs-watcher.ts` — **modify**: `workspaceFolder: vscode.WorkspaceFolder` → `assignmentRoot: string` (for `RelativePattern` base) + `isOwnedByThisRoot` guard for defense-in-depth.
- `packages/recorder/src/wiring/fs-watcher.test.ts` — **modify**.
- `packages/recorder/src/commands/seal.ts` — **modify**: `workspaceFolder` param → `assignmentRoot: string` (decision 6).
- `packages/recorder/src/commands/seal.test.ts` — **modify**: update fixtures for the renamed param.
- `packages/recorder/src/wiring/terminal-wiring.ts` — **modify**: add cwd resolution + `isOwnedByThisRoot` guard.
- `packages/recorder/src/wiring/terminal-wiring.test.ts` — **modify**.
- `packages/recorder/src/wiring/git-wiring.ts` — **modify**: add `rootUri`-based routing + `isOwnedByThisRoot` guard.
- `packages/recorder/src/wiring/git-wiring.test.ts` — **modify**.
- `packages/recorder/src/commands/seal-selector.ts` — **create**: pure `pickSessionLabel()` / `chooseSessionForSeal()` QuickPick-shape helpers, testable without a real QuickPick.
- `packages/recorder/src/commands/seal-selector.test.ts` — **create**.
- `packages/recorder/package.json` — **modify**: `activationEvents` → glob forms.
- `packages/recorder/test/integration/suite/recorder.test.ts` — **unchanged** (regression: single manifest at opened root still yields one session; verified in Task 9, not modified).

---

## Task 1: Widen `loadAndVerifyManifest` + add `discoverManifests()`

**Files:**
- Modify: `packages/recorder/src/activation/manifest-loader.ts:48-51` (signature only)
- Create: `packages/recorder/src/activation/manifest-discovery.ts`
- Test: `packages/recorder/src/activation/manifest-discovery.test.ts`

**Interfaces:**
- Consumes: `loadAndVerifyManifest` (widened), `MANIFEST_FILE_NAMES`, `ActivationError`, `Manifest`, `Result` from `@provenance/log-core`.
- Produces:
  - `export type DiscoveredManifest = { root: string; manifest: Manifest }`
  - `export type ManifestSkip = { root: string; error: import('./manifest-loader.js').ActivationError }`
  - `export type DiscoveryDeps = { workspaceFolders: readonly { uri: { fsPath: string } }[]; findFiles: (include: string, exclude: string) => Promise<{ fsPath: string }[]>; pubkeyHex?: string }`
  - `export async function discoverManifests(deps: DiscoveryDeps): Promise<{ found: DiscoveredManifest[]; skipped: ManifestSkip[] }>`

- [ ] **Step 1: Widen `loadAndVerifyManifest`'s parameter type**

In `packages/recorder/src/activation/manifest-loader.ts`, change the signature (lines 48-51) from:

```ts
export async function loadAndVerifyManifest(
  workspaceFolder: vscode.WorkspaceFolder,
  pubkeyHex: string = COURSE_PUBLIC_KEY_HEX,
): Promise<Result<Manifest, ActivationError>> {
```

to:

```ts
/** Minimal structural type — a vscode.WorkspaceFolder already satisfies this. */
export type FolderLike = { uri: { fsPath: string } };

export async function loadAndVerifyManifest(
  workspaceFolder: FolderLike,
  pubkeyHex: string = COURSE_PUBLIC_KEY_HEX,
): Promise<Result<Manifest, ActivationError>> {
```

Remove the now-unused `import * as vscode from 'vscode';` only if nothing else in the file references `vscode` — check first (the file only imports it for the `WorkspaceFolder` type, so after this edit the import can be deleted; confirm with a repo-wide grep on `vscode\.` in this file before deleting).

- [ ] **Step 2: Run existing tests to confirm nothing broke**

Run: `npm run test --workspace=packages/recorder -- manifest-loader`
Expected: PASS (all existing `manifest-loader.test.ts` cases still pass — `FolderLike` is structurally identical to what tests already construct).

- [ ] **Step 3: Write the failing discovery test**

`discoverManifests` calls `loadAndVerifyManifest` per candidate directory, which does its own `fsPromises.readFile` internally — so this test uses real temp directories (`fs.mkdtemp` + `fs.writeFile`) rather than mocking `fs`, mirroring the pattern already used in `activation.integration.test.ts`. Create `packages/recorder/src/activation/manifest-discovery.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as ed from '@noble/ed25519';
import { bytesToHex } from '@noble/hashes/utils.js';
import { canonicalize } from '@provenance/log-core';
import { discoverManifests } from './manifest-discovery.js';

async function generateTestKeypair(): Promise<{ pubkeyHex: string; privkeyHex: string }> {
  const secretKey = ed.utils.randomSecretKey();
  const publicKey = await ed.getPublicKeyAsync(secretKey);
  return { pubkeyHex: bytesToHex(publicKey), privkeyHex: Buffer.from(secretKey).toString('hex') };
}

async function writeSignedManifest(
  dir: string,
  fields: { assignment_id: string; semester: string; issued_at: string; files_under_review: string[] },
  privkeyHex: string,
): Promise<void> {
  const payload = canonicalize(fields);
  const sig = await ed.signAsync(new TextEncoder().encode(payload), Buffer.from(privkeyHex, 'hex'));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, '.provenance-manifest'),
    JSON.stringify({ ...fields, sig: bytesToHex(sig) }),
    'utf8',
  );
}

describe('discoverManifests', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'provenance-discovery-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('verifies a manifest at each discovered directory and skips invalid ones', async () => {
    const { pubkeyHex, privkeyHex } = await generateTestKeypair();
    const { privkeyHex: wrongPrivkey } = await generateTestKeypair();

    const catsDir = path.join(tmpDir, 'cats');
    const hogDir = path.join(tmpDir, 'hog');
    await writeSignedManifest(
      catsDir,
      { assignment_id: 'cats', semester: 'fa26', issued_at: '2026-01-01T00:00:00Z', files_under_review: ['hw.py'] },
      privkeyHex,
    );
    await writeSignedManifest(
      hogDir,
      // signed with a DIFFERENT key than pubkeyHex below — verification must fail for this one
      { assignment_id: 'hog', semester: 'fa26', issued_at: '2026-01-01T00:00:00Z', files_under_review: ['hw.py'] },
      wrongPrivkey,
    );

    const result = await discoverManifests({
      workspaceFolders: [{ uri: { fsPath: tmpDir } }],
      findFiles: async () => [
        { fsPath: path.join(catsDir, '.provenance-manifest') },
        { fsPath: path.join(hogDir, '.provenance-manifest') },
      ],
      pubkeyHex,
    });

    expect(result.found.map((f) => f.root)).toEqual([catsDir]);
    expect(result.skipped.map((s) => s.root)).toEqual([hogDir]);
    expect(result.skipped[0]?.error.kind).toBe('manifest_signature_invalid');
  });

  it('returns no sessions for a folder with no manifest anywhere', async () => {
    const result = await discoverManifests({
      workspaceFolders: [{ uri: { fsPath: tmpDir } }],
      findFiles: async () => [],
    });
    expect(result.found).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it('discovers a manifest at the opened root itself (regression: single-assignment case)', async () => {
    const { pubkeyHex, privkeyHex } = await generateTestKeypair();
    await writeSignedManifest(
      tmpDir,
      { assignment_id: 'hw03', semester: 'fa26', issued_at: '2026-01-01T00:00:00Z', files_under_review: ['hw.py'] },
      privkeyHex,
    );
    const result = await discoverManifests({
      workspaceFolders: [{ uri: { fsPath: tmpDir } }],
      findFiles: async () => [{ fsPath: path.join(tmpDir, '.provenance-manifest') }],
      pubkeyHex,
    });
    expect(result.found).toHaveLength(1);
    expect(result.found[0]?.root).toBe(tmpDir);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npm run test --workspace=packages/recorder -- manifest-discovery`
Expected: FAIL with "Cannot find module './manifest-discovery.js'" (file doesn't exist yet).

- [ ] **Step 5: Implement `discoverManifests`**

Create `packages/recorder/src/activation/manifest-discovery.ts`:

```ts
/**
 * Discovers `.provenance-manifest`/`provenance-manifest` files nested anywhere under
 * the opened workspace folder(s), verifies each candidate, and reports both the
 * verified set and the skipped (invalid/unreadable) set.
 *
 * PRD relationship: this is the multi-root generalization of manifest-loader.ts's
 * single-root `loadAndVerifyManifest`. Verification itself is delegated to that
 * function unchanged — this module only adds the "find candidate directories" step.
 *
 * A bad manifest at one directory must never block discovery/activation at another
 * (spec integrity invariant) — callers rely on `skipped` being purely informational.
 */

import * as path from 'node:path';
import { loadAndVerifyManifest, type FolderLike, type ActivationError } from './manifest-loader.js';
import type { Manifest } from '@provenance/log-core';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DiscoveredManifest = { root: string; manifest: Manifest };
export type ManifestSkip = { root: string; error: ActivationError };

export type DiscoveryDeps = {
  /** All currently open workspace folders (vscode.workspace.workspaceFolders in production). */
  workspaceFolders: readonly FolderLike[];
  /**
   * Finds candidate manifest file paths under the given include glob, honoring the
   * exclude glob. Production wires this to vscode.workspace.findFiles; tests inject
   * a stub returning fixed paths. Exclude is fixed by the caller (see excludeGlob below)
   * so this seam only needs the include pattern from us.
   */
  findFiles: (include: string, exclude: string) => Promise<readonly { fsPath: string }[]>;
  pubkeyHex?: string;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Matches both manifest filename variants at any depth. Kept in sync with
 * MANIFEST_FILE_NAMES in manifest-loader.ts (brace-expansion form for findFiles).
 */
export const MANIFEST_INCLUDE_GLOB = '**/{.provenance-manifest,provenance-manifest}';

/**
 * Excludes heavy/irrelevant directories from the scan: VCS metadata, dependency
 * trees, and the recorder's own per-assignment output directories (a `.provenance/`
 * never itself contains a manifest, but excluding it keeps the walk cheap and avoids
 * ever treating a stale bundled manifest.json as an activation manifest).
 */
export const MANIFEST_EXCLUDE_GLOB = '**/{node_modules,.git,.provenance}/**';

// ---------------------------------------------------------------------------
// discoverManifests
// ---------------------------------------------------------------------------

export async function discoverManifests(
  deps: DiscoveryDeps,
): Promise<{ found: DiscoveredManifest[]; skipped: ManifestSkip[] }> {
  const { workspaceFolders, findFiles, pubkeyHex } = deps;

  // Collect candidate manifest directories across all open folders, deduped by
  // resolved directory (a directory yields at most one session — spec Design §1 —
  // even if both filename variants are present there).
  const candidateDirs = new Set<string>();

  for (const folder of workspaceFolders) {
    const matches = await findFiles(MANIFEST_INCLUDE_GLOB, MANIFEST_EXCLUDE_GLOB);
    for (const uri of matches) {
      candidateDirs.add(path.dirname(uri.fsPath));
    }
    void folder; // findFiles already scopes to the workspace in production (VS Code semantics);
    // kept in the loop signature so a future multi-root-aware findFiles implementation
    // (scoped per folder) is a drop-in replacement.
  }

  const found: DiscoveredManifest[] = [];
  const skipped: ManifestSkip[] = [];

  for (const root of [...candidateDirs].sort()) {
    const result = await loadAndVerifyManifest({ uri: { fsPath: root } }, pubkeyHex);
    if (result.ok) {
      found.push({ root, manifest: result.value });
    } else {
      skipped.push({ root, error: result.error });
    }
  }

  return { found, skipped };
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm run test --workspace=packages/recorder -- manifest-discovery`
Expected: PASS (3 tests).

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck --workspace=packages/recorder`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/recorder/src/activation/manifest-loader.ts packages/recorder/src/activation/manifest-discovery.ts packages/recorder/src/activation/manifest-discovery.test.ts
git commit --no-gpg-sign -m "feat(recorder): discover nested .provenance-manifest files"
```

---

## Task 2: Pure nearest-ancestor ownership resolver

**Files:**
- Create: `packages/recorder/src/session/session-router.ts`
- Test: `packages/recorder/src/session/session-router.test.ts`

**Interfaces:**
- Consumes: nothing (pure, `node:path` only).
- Produces: `export function resolveOwnerRoot(filePath: string, assignmentRoots: readonly string[]): string | null` — used by Tasks 4-8 to build each session's `isOwnedByThisRoot` predicate.

- [ ] **Step 1: Write the failing test**

Create `packages/recorder/src/session/session-router.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { resolveOwnerRoot } from './session-router.js';

describe('resolveOwnerRoot', () => {
  const cats = path.join('/ws', '61a', 'cats');
  const hog = path.join('/ws', '61a', 'hog');
  const roots = [cats, hog];

  it('routes a file under one root to that root only', () => {
    expect(resolveOwnerRoot(path.join(cats, 'x.py'), roots)).toBe(cats);
  });

  it('routes a file under a sibling root to that root, not the first one', () => {
    expect(resolveOwnerRoot(path.join(hog, 'y.py'), roots)).toBe(hog);
  });

  it('returns null for a file owned by no root', () => {
    expect(resolveOwnerRoot(path.join('/ws', '61a', 'notes.md'), roots)).toBeNull();
  });

  it('does not treat a sibling with a shared string prefix as owned', () => {
    // "cats-extra" starts with the string "cats" but is not inside the cats/ directory.
    const catsExtra = path.join('/ws', '61a', 'cats-extra');
    expect(resolveOwnerRoot(path.join(catsExtra, 'z.py'), roots)).toBeNull();
  });

  it('nearest-enclosing manifest wins for a nested case', () => {
    const catsNested = path.join(cats, 'subproj');
    const nestedRoots = [cats, catsNested];
    expect(resolveOwnerRoot(path.join(catsNested, 'a.py'), nestedRoots)).toBe(catsNested);
    expect(resolveOwnerRoot(path.join(cats, 'b.py'), nestedRoots)).toBe(cats);
  });

  it('a path equal to the root itself is owned by that root', () => {
    expect(resolveOwnerRoot(cats, roots)).toBe(cats);
  });

  it('returns null when there are no roots at all', () => {
    expect(resolveOwnerRoot(path.join(cats, 'x.py'), [])).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace=packages/recorder -- session-router`
Expected: FAIL with "Cannot find module './session-router.js'".

- [ ] **Step 3: Implement `resolveOwnerRoot`**

Create `packages/recorder/src/session/session-router.ts`:

```ts
/**
 * Pure nearest-ancestor ownership resolution (spec Design §3, Locked decision 5:
 * "A file belongs to the session of the nearest ancestor directory that has a
 * verified manifest"). No VS Code imports — testable in complete isolation.
 *
 * This is the single source of truth "given a path, which assignment root owns
 * it?" answer that every wiring module (doc, fs-watcher, terminal, git) consults
 * to build its own isOwnedByThisRoot filter (plan decision 2).
 */

import * as path from 'node:path';

/**
 * Resolve which of `assignmentRoots` is the nearest ancestor of `filePath`, or
 * null if none of them contain it.
 *
 * "Nearest ancestor" = the longest matching root path (a root nested inside
 * another root wins for paths beneath it, per spec Locked decision 5).
 *
 * A path equal to a root itself is considered owned by that root (path.relative
 * returns '' in that case).
 */
export function resolveOwnerRoot(
  filePath: string,
  assignmentRoots: readonly string[],
): string | null {
  let best: string | null = null;

  for (const root of assignmentRoots) {
    const rel = path.relative(root, filePath);
    const isInside = rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
    if (!isInside) continue;

    if (best === null || root.length > best.length) {
      best = root;
    }
  }

  return best;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test --workspace=packages/recorder -- session-router`
Expected: PASS (7 tests).

- [ ] **Step 5: Typecheck + lint**

Run: `npm run typecheck --workspace=packages/recorder && npm run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/recorder/src/session/session-router.ts packages/recorder/src/session/session-router.test.ts
git commit --no-gpg-sign -m "feat(recorder): add nearest-ancestor session ownership resolver"
```

---

## Task 3: Assignment-relative path helper

**Files:**
- Create: `packages/recorder/src/session/assignment-relative-path.ts`
- Test: `packages/recorder/src/session/assignment-relative-path.test.ts`

**Interfaces:**
- Consumes: nothing (pure, `node:path` only).
- Produces: `export function makeAssignmentRelativePath(assignmentRoot: string): (fsPath: string) => string` — returns a function matching the shape doc-events.ts's `WorkspaceLike['asRelativePath']` needs (modulo the `vscode.Uri` vs plain string argument, reconciled in Task 4).

- [ ] **Step 1: Write the failing test**

Create `packages/recorder/src/session/assignment-relative-path.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { makeAssignmentRelativePath } from './assignment-relative-path.js';

describe('makeAssignmentRelativePath', () => {
  it('computes a path relative to the assignment root, not any outer folder', () => {
    const root = path.join('/ws', '61a', 'cats');
    const toRelative = makeAssignmentRelativePath(root);
    expect(toRelative(path.join(root, 'hw.py'))).toBe('hw.py');
    expect(toRelative(path.join(root, 'src', 'main.py'))).toBe(path.join('src', 'main.py'));
  });

  it('matches plain path.relative semantics for the regression case (root == opened folder)', () => {
    const root = path.join('/ws', 'hw03');
    const toRelative = makeAssignmentRelativePath(root);
    expect(toRelative(path.join(root, 'hw.py'))).toBe('hw.py');
  });

  it('returns the absolute fsPath unchanged for a file outside the root (mirrors asRelativePath convention)', () => {
    const root = path.join('/ws', '61a', 'cats');
    const outside = path.join('/ws', '61a', 'notes.md');
    const toRelative = makeAssignmentRelativePath(root);
    expect(toRelative(outside)).toBe(outside);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace=packages/recorder -- assignment-relative-path`
Expected: FAIL with "Cannot find module './assignment-relative-path.js'".

- [ ] **Step 3: Implement `makeAssignmentRelativePath`**

Create `packages/recorder/src/session/assignment-relative-path.ts`:

```ts
/**
 * Assignment-root-relative path resolution (plan decision 4).
 *
 * vscode.workspace.asRelativePath() resolves relative to whichever *opened*
 * workspace folder contains a file. That happened to equal the assignment root
 * when a workspace folder WAS the assignment root (the pre-nested-discovery
 * invariant this whole feature breaks). Once one opened folder can contain
 * several assignment roots, doc.* payload paths, files_under_review matching,
 * and read-file resolution all need paths relative to the OWNING assignment
 * root specifically — not the outer folder. This module computes that,
 * independent of any vscode.workspace state.
 *
 * The "outside root" fallback (return the fsPath unchanged) mirrors
 * vscode.workspace.asRelativePath's own convention, which existing callers
 * (doc-wiring's isRecordable) rely on to detect "outside" via `rel === fsPath`.
 */

import * as path from 'node:path';

export function makeAssignmentRelativePath(
  assignmentRoot: string,
): (fsPath: string) => string {
  return (fsPath: string): string => {
    const rel = path.relative(assignmentRoot, fsPath);
    const isInside = rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
    return isInside ? rel : fsPath;
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test --workspace=packages/recorder -- assignment-relative-path`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck + lint**

Run: `npm run typecheck --workspace=packages/recorder && npm run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/recorder/src/session/assignment-relative-path.ts packages/recorder/src/session/assignment-relative-path.test.ts
git commit --no-gpg-sign -m "feat(recorder): add assignment-root-relative path helper"
```

---

## Task 4: Extract per-root session activation into `session-registry.ts::startSession` (HIGHEST REASONING — use `opus`)

This is the highest-risk task: the ~400-line body of `activateImpl` (currently `packages/recorder/src/extension.ts:179-574`) must move into a standalone, reusable function parameterized on an assignment root, **without changing observable behavior for the existing single-root case**. Get this exactly right before Task 5 adds multi-session orchestration on top — that separation is deliberate so a reviewer can verify "pure refactor, no behavior change" before "new behavior" is layered on.

**Files:**
- Create: `packages/recorder/src/session/session-registry.ts` (add `ActiveSession` type + `startSession()` only in this task — the `SessionRegistry` class itself is Task 5)
- Modify: `packages/recorder/src/extension.ts` (delete the extracted body; `activateImpl` becomes a thin wrapper: verify manifest for the single workspace folder as before, call `startSession()`, keep `activeSession`/`deactivate()` exactly as they are today)
- Test: `packages/recorder/src/session/session-registry.test.ts` (new — the moved logic's happy-path + chain-recovery + disk-full-degraded coverage, adapted from what `activation.integration.test.ts` exercises today)
- Do NOT modify `packages/recorder/src/activation/activation.integration.test.ts` in this task — it must keep passing unmodified against the still-present `activateImpl`/`activate()`/`deactivate()` exports, proving the extraction is behavior-preserving. (Task 5 will update it for multi-session discovery.)

**Interfaces:**
- Consumes: everything `activateImpl` already consumes today (see `packages/recorder/src/extension.ts:1-49` imports) — no new imports beyond `path` (already imported) and the modules already used inside `activateImpl`.
- Produces:
  ```ts
  export type ActiveSession = {
    assignmentRoot: string;
    manifest: Manifest;
    provenanceDir: string;
    slogPath: string;
    writer: SessionWriter;
    metaWriter: MetaWriter;
    sessionHost: ReturnType<typeof createSessionHost>;
    sessionKeypair: { privateKey: Uint8Array; publicKeyHex: string };
    /** All VS Code subscriptions this session owns (doc-wiring, fs-watcher, heartbeat, etc). Disposed by dispose(). */
    ownDisposables: vscode.Disposable[];
    getPendingCheckpoint: () => Promise<void>;
    /** Emits session.end, flushes the writer, drains the pending checkpoint, disposes metaWriter + ownDisposables, in that order. */
    dispose: () => Promise<void>;
  };

  export type StartSessionDeps = {
    assignmentRoot: string;
    manifest: Manifest;
    extension: vscode.Extension<unknown>;
    vscodeVersion: string;
    platform: string;
    clock: Clock;
    provenanceDirOverride?: string;
    heartbeatDeps?: HeartbeatVscodeDeps;
    extensionDistPath?: string;
    /** Used by doc-wiring/fs-watcher/terminal-wiring/git-wiring's ownership filter (Tasks 6-8). Defaults to "always owned" (`() => true`) so single-session callers (and this task's own tests) need not supply it. */
    isOwnedByThisRoot?: (fsPath: string) => boolean;
  };

  export async function startSession(deps: StartSessionDeps): Promise<ActiveSession>;
  ```
  Task 5 consumes `ActiveSession` and `startSession` directly; Tasks 6-8 consume the `isOwnedByThisRoot` deps field.

- [ ] **Step 1: Write the failing test for the extracted function**

Create `packages/recorder/src/session/session-registry.test.ts`. This intentionally mirrors the two core cases from `activation.integration.test.ts` (happy path + chain validation), run instead against the new `startSession` directly, so both old and new tests double-cover the extraction until Task 5 is done:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as ed from '@noble/ed25519';
import { bytesToHex } from '@noble/hashes/utils.js';
import { FixedClock, parseEntries, validateChain, canonicalize } from '@provenance/log-core';
import type { Manifest } from '@provenance/log-core';
import { startSession } from './session-registry.js';

function makeExtension(): import('vscode').Extension<unknown> {
  return {
    id: 'itsgeagle.provenance-recorder',
    extensionUri: { fsPath: '/fake/ext' } as import('vscode').Uri,
    extensionPath: '/fake/ext',
    isActive: true,
    packageJSON: { version: '0.0.0', publisher: 'itsgeagle', name: 'provenance-recorder' },
    exports: undefined,
    activate: () => Promise.resolve(undefined),
    extensionKind: 1 as import('vscode').ExtensionKind,
  };
}

async function signedManifest(
  fields: { assignment_id: string; semester: string; issued_at: string; files_under_review: string[] },
): Promise<Manifest> {
  const secretKey = ed.utils.randomSecretKey();
  const payload = canonicalize(fields);
  const sig = await ed.signAsync(new TextEncoder().encode(payload), secretKey);
  return { ...fields, sig: bytesToHex(sig) };
}

describe('startSession', () => {
  let tmpDir: string;
  let assignmentRoot: string;
  let provenanceDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'provenance-session-'));
    assignmentRoot = path.join(tmpDir, 'workspace');
    provenanceDir = path.join(tmpDir, 'provenance');
    await fs.mkdir(assignmentRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('creates .provenance/ dir and a .slog file with a valid session.start entry', async () => {
    const manifest = await signedManifest({
      assignment_id: 'hw03',
      semester: 'fa26',
      issued_at: '2026-09-15T00:00:00Z',
      files_under_review: ['hw.py'],
    });

    const clock = new FixedClock(0, new Date('2026-01-01T00:00:00.000Z'));

    const session = await startSession({
      assignmentRoot,
      manifest,
      extension: makeExtension(),
      vscodeVersion: '1.97.0',
      platform: 'darwin-arm64',
      clock,
      provenanceDirOverride: provenanceDir,
    });

    expect(session.slogPath).toContain('session-');
    expect(session.assignmentRoot).toBe(assignmentRoot);

    await session.dispose();

    const slogContents = await fs.readFile(session.slogPath, 'utf8');
    const parseResult = parseEntries(slogContents);
    expect(parseResult.ok).toBe(true);
    if (!parseResult.ok) return;

    const entries = parseResult.value;
    expect(entries[0]?.kind).toBe('session.start');
    expect(entries[entries.length - 1]?.kind).toBe('session.end');

    const chainResult = validateChain(entries);
    expect(chainResult.ok).toBe(true);
  });

  it('two independent calls to startSession produce independently chained sessions', async () => {
    const manifestA = await signedManifest({
      assignment_id: 'cats',
      semester: 'fa26',
      issued_at: '2026-09-15T00:00:00Z',
      files_under_review: ['hw.py'],
    });
    const manifestB = await signedManifest({
      assignment_id: 'hog',
      semester: 'fa26',
      issued_at: '2026-09-15T00:00:00Z',
      files_under_review: ['hw.py'],
    });

    const rootA = path.join(tmpDir, 'cats');
    const rootB = path.join(tmpDir, 'hog');
    await fs.mkdir(rootA, { recursive: true });
    await fs.mkdir(rootB, { recursive: true });

    const clock = new FixedClock(0, new Date('2026-01-01T00:00:00.000Z'));

    const sessionA = await startSession({
      assignmentRoot: rootA,
      manifest: manifestA,
      extension: makeExtension(),
      vscodeVersion: '1.97.0',
      platform: 'darwin-arm64',
      clock,
      provenanceDirOverride: path.join(rootA, '.provenance'),
    });
    const sessionB = await startSession({
      assignmentRoot: rootB,
      manifest: manifestB,
      extension: makeExtension(),
      vscodeVersion: '1.97.0',
      platform: 'darwin-arm64',
      clock,
      provenanceDirOverride: path.join(rootB, '.provenance'),
    });

    expect(sessionA.sessionHost.sessionId).not.toBe(sessionB.sessionHost.sessionId);
    expect(sessionA.provenanceDir).not.toBe(sessionB.provenanceDir);

    await sessionA.dispose();
    await sessionB.dispose();

    // Each session's .slog only contains ITS OWN manifest's assignment id.
    const contentsA = await fs.readFile(sessionA.slogPath, 'utf8');
    const contentsB = await fs.readFile(sessionB.slogPath, 'utf8');
    expect(contentsA).toContain('"cats"');
    expect(contentsA).not.toContain('"hog"');
    expect(contentsB).toContain('"hog"');
    expect(contentsB).not.toContain('"cats"');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace=packages/recorder -- session-registry`
Expected: FAIL with "Cannot find module './session-registry.js'".

- [ ] **Step 3: Extract the per-root activation body**

Create `packages/recorder/src/session/session-registry.ts` by moving the body of `activateImpl` (`packages/recorder/src/extension.ts`, currently lines 179-574, from "Step 1: Load and verify the manifest" — actually keep manifest loading OUT of this function; discovery/verification happens in the caller now — down through "Store the active session ... return activeSession;") into this new file as `startSession()`. Concretely:

1. Copy `packages/recorder/src/extension.ts`'s imports for: `fsPromises`, `readFileSync`, `path`, `randomUUID`, `SystemClock` (NOT needed — clock is injected), `generateSessionKeypair`, `encryptSessionPrivkey`, `signCheckpoint`, `HashedEnvelope` type, `buildRecorderContext`, `createSessionHost`, `SessionWriter`, `MetaWriter`, `startHeartbeat`, `startClockWatcher`, `startDocWiring`, `startPasteIntercept`, `startPasteReconciler`, `startFsWatcher`, `ExplanationTagger`, `ExpectedContentRegistry`, `startTerminalWiring`, `startExtensionSnapshot`, `startExtensionActivation`, `startGitWiring`, `recoverPreviousSession`, `computeExtensionHash`, `DiskFullHandler`, `LargeInsertCounter` type, `Manifest` type, plus `vscode`.
2. Additionally import `makeAssignmentRelativePath` from `./assignment-relative-path.js` (Task 3) and `Clock` type + `HeartbeatVscodeDeps` type (move `HeartbeatVscodeDeps` and `defaultHeartbeatDeps` into this file too — they're only used here).
3. Rename every occurrence of `workspaceFolder.uri.fsPath` (the extraction source used `workspaceFolder` throughout — see `extension.ts:216`, `:403-405`, `:437`, `:511-513` via closures) to the new `assignmentRoot: string` parameter directly. There is no `workspaceFolder` object anymore inside this function — only the plain `assignmentRoot` string, `manifest`, and the rest of `StartSessionDeps`.
4. Replace the `docWiring`'s `workspace: { asRelativePath: vscode.workspace.asRelativePath.bind(vscode.workspace) }` (extension.ts:412) with `workspace: { asRelativePath: makeAssignmentRelativePath(assignmentRoot) }` — this is the wiring for plan decision 4; `doc-wiring.ts`'s `WorkspaceLike` interface takes a `vscode.Uri` today (`asRelativePath: (uri: vscode.Uri) => string`) so pass an adapter: `{ asRelativePath: (uri) => makeAssignmentRelativePath(assignmentRoot)(uri.fsPath) }`. (Task 6 will additionally thread the ownership filter through `DocWiringDeps`; this task only fixes the relative-path source, keeping today's single-root behavior identical since `assignmentRoot === workspaceFolder.uri.fsPath` in the regression case.)
5. `startFsWatcher`'s `workspaceFolder: vscode.WorkspaceFolder` param: for this task, keep passing an object shaped `{ uri: { fsPath: assignmentRoot } } as vscode.WorkspaceFolder` (a minimal cast) so `fs-watcher.ts` doesn't need to change yet — Task 7 does the real signature cleanup there. Do NOT change `fs-watcher.ts` in this task.
6. `sealBundle`'s caller (the `provenance.prepareSubmissionBundle` command registration, extension.ts:523-556) stays in `extension.ts`, NOT in `session-registry.ts` — `startSession()` returns the `ActiveSession`; command registration (which needs to know about ALL sessions for the QuickPick) is Task 5/9's job. However, the manifest-scoped values the seal command needs (`assignmentRoot`, `manifest.assignment_id`, `manifest.semester`, `manifest.files_under_review`, `sessionKeypair.privateKey`, `sessionKeypair.publicKeyHex`, `computeExtensionHash`) must all be readable off the returned `ActiveSession` — add them to the `ActiveSession` type as shown in this task's Interfaces block (`manifest`, `sessionKeypair`).
7. Build `dispose()` as a closure inside `startSession` replacing today's module-level `deactivate()` body (extension.ts:656-696), operating on this session's own `sessionHost`/`writer`/`getPendingCheckpoint`/`metaWriter`/`ownDisposables` instead of the module-level `activeSession`.

The full extracted file:

```ts
/**
 * session-registry.ts — per-assignment-root session lifecycle.
 *
 * startSession() is the direct extraction of what used to be the single-session
 * body of extension.ts's activateImpl(): manifest is already verified by the
 * caller (activation/manifest-discovery.ts); this function owns everything from
 * "create .provenance/" through "register this session's own wiring" and returns
 * an ActiveSession whose dispose() tears down exactly this session.
 *
 * PRD §4.1: manifest is already verified before this is called.
 * PRD §5.1: emits session.start with full context; session.end on dispose().
 * PRD §4.2: session.heartbeat every 30s; clock.skew on wall-clock drift.
 * PRD §4.7: buffered, async I/O via SessionWriter.
 */

import * as vscode from 'vscode';
import * as fsPromises from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  generateSessionKeypair,
  encryptSessionPrivkey,
  signCheckpoint,
} from '@provenance/log-core';
import type { HashedEnvelope, Clock, Manifest } from '@provenance/log-core';
import { createRecordingStatusBar } from '../activation/status-bar.js';
import { buildRecorderContext } from './recorder-context.js';
import { createSessionHost } from './session-host.js';
import { SessionWriter } from '../io/session-writer.js';
import { MetaWriter } from '../io/meta-writer.js';
import { startHeartbeat } from '../events/heartbeat.js';
import { startClockWatcher } from '../events/clock-watcher.js';
import { startDocWiring } from '../wiring/doc-wiring.js';
import { startPasteIntercept } from '../wiring/paste-command-intercept.js';
import { startPasteReconciler } from '../events/paste-reconciler.js';
import { startFsWatcher } from '../wiring/fs-watcher.js';
import { ExplanationTagger } from '../events/explanation-tags.js';
import { ExpectedContentRegistry } from '../state/expected-content-registry.js';
import { startTerminalWiring } from '../wiring/terminal-wiring.js';
import { startExtensionSnapshot } from '../wiring/extension-snapshot.js';
import { startExtensionActivation } from '../wiring/extension-activation.js';
import { startGitWiring } from '../wiring/git-wiring.js';
import { recoverPreviousSession } from '../startup/chain-recovery.js';
import { computeExtensionHash } from '../commands/extension-hash.js';
import { DiskFullHandler } from '../failure/disk-full-handler.js';
import { makeAssignmentRelativePath } from './assignment-relative-path.js';
import type { LargeInsertCounter } from '../wiring/doc-wiring.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HeartbeatVscodeDeps = {
  windowState: { focused: boolean };
  activeTextEditor: () => string | null;
  onDidChangeFocus: (handler: () => void) => vscode.Disposable;
  onDidChangeActiveTextEditor: (handler: () => void) => vscode.Disposable;
  onDidChangeTextDocument: (handler: () => void) => vscode.Disposable;
};

export type ActiveSession = {
  assignmentRoot: string;
  manifest: Manifest;
  provenanceDir: string;
  slogPath: string;
  writer: SessionWriter;
  metaWriter: MetaWriter;
  sessionHost: ReturnType<typeof createSessionHost>;
  sessionKeypair: { privateKey: Uint8Array; publicKeyHex: string };
  ownDisposables: vscode.Disposable[];
  getPendingCheckpoint: () => Promise<void>;
  dispose: () => Promise<void>;
};

export type StartSessionDeps = {
  assignmentRoot: string;
  manifest: Manifest;
  extension: vscode.Extension<unknown>;
  vscodeVersion: string;
  platform: string;
  clock: Clock;
  provenanceDirOverride?: string;
  heartbeatDeps?: HeartbeatVscodeDeps;
  extensionDistPath?: string;
  /** Ownership filter for this session's wiring (Tasks 6-8). Defaults to "always owned". */
  isOwnedByThisRoot?: (fsPath: string) => boolean;
  /** Mount a status bar item for THIS session. Defaults to a no-op — extension.ts mounts one global status bar, not one per session (plan decision 5). */
  createStatusBar?: (disposables: vscode.Disposable[]) => vscode.StatusBarItem;
};

// ---------------------------------------------------------------------------
// defaultHeartbeatDeps
// ---------------------------------------------------------------------------

export function defaultHeartbeatDeps(): HeartbeatVscodeDeps {
  return {
    windowState: vscode.window.state,
    activeTextEditor: () => {
      const editor = vscode.window.activeTextEditor;
      return editor ? vscode.workspace.asRelativePath(editor.document.uri) : null;
    },
    onDidChangeFocus: (h) => vscode.window.onDidChangeWindowState(h),
    onDidChangeActiveTextEditor: (h) => vscode.window.onDidChangeActiveTextEditor(h),
    onDidChangeTextDocument: (h) => vscode.workspace.onDidChangeTextDocument(h),
  };
}

// ---------------------------------------------------------------------------
// startSession
// ---------------------------------------------------------------------------

export async function startSession(deps: StartSessionDeps): Promise<ActiveSession> {
  const { assignmentRoot, manifest, extension, vscodeVersion, platform, clock } = deps;
  const isOwnedByThisRoot = deps.isOwnedByThisRoot ?? (() => true);
  const ownDisposables: vscode.Disposable[] = [];

  if (deps.createStatusBar !== undefined) {
    deps.createStatusBar(ownDisposables);
  }

  const provenanceDir = deps.provenanceDirOverride ?? path.join(assignmentRoot, '.provenance');
  await fsPromises.mkdir(provenanceDir, { recursive: true });

  const recovery = await recoverPreviousSession({
    provenanceDir,
    readSlogFile: async (p) => {
      try {
        const text = await fsPromises.readFile(p, 'utf8');
        return { ok: true, text };
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        return { ok: false, reason: code === 'ENOENT' ? 'not_found' : 'read_error' };
      }
    },
    rename: fsPromises.rename,
    listSlogFiles: async (dir) => {
      try {
        const entries = await fsPromises.readdir(dir);
        return entries.filter((f) => f.endsWith('.slog'));
      } catch {
        return [];
      }
    },
    now: () => new Date(),
  });

  const prevSessionId: string | null =
    recovery.kind === 'previous_session_dangling' ? recovery.prevSessionId : null;

  const keypair = await generateSessionKeypair();

  const recorderContext = buildRecorderContext({
    manifest,
    prevSessionId,
    extension,
    vscodeVersion,
    platform,
    sessionPubkeyHex: keypair.publicKeyHex,
  });

  const slogPath = path.join(provenanceDir, `session-${randomUUID()}.slog`);

  let sessionHostEmit: ((kind: 'recorder.degraded', data: { reason: string }) => void) | null =
    null;

  const diskFullHandler = new DiskFullHandler({
    onDegraded: (data) => {
      sessionHostEmit?.('recorder.degraded', { reason: data.reason });
    },
    notify: (msg) => {
      void vscode.window.showErrorMessage(msg);
    },
  });

  const writer = await SessionWriter.open({
    slogPath,
    clock,
    onError: (e) => diskFullHandler.handleWriteError(e),
  });

  const encryptedPrivkey = await encryptSessionPrivkey(
    keypair.privateKey,
    manifest.sig,
    recorderContext.session_id,
  );
  const metaPath = `${slogPath}.meta`;
  const metaWriter = await MetaWriter.create({
    metaPath,
    sessionId: recorderContext.session_id,
    sessionPubkeyHex: keypair.publicKeyHex,
    encryptedPrivkey,
  });

  const CHECKPOINT_INTERVAL = 100;
  let entryCountSinceLastCheckpoint = 0;
  let pendingCheckpoint: Promise<void> = Promise.resolve();

  const sessionHost = createSessionHost({
    sessionId: recorderContext.session_id,
    clock,
    onEntry: (entry: HashedEnvelope) => {
      if (diskFullHandler.degraded) {
        diskFullHandler.enqueue(entry);
        return;
      }

      writer.append(entry);
      entryCountSinceLastCheckpoint++;
      if (entryCountSinceLastCheckpoint >= CHECKPOINT_INTERVAL) {
        entryCountSinceLastCheckpoint = 0;
        pendingCheckpoint = pendingCheckpoint
          .then(() => signCheckpoint(entry.seq, entry.hash, keypair.privateKey))
          .then((cp) => metaWriter.appendCheckpoint(cp))
          .catch((e: unknown) => {
            console.error('[provenance] checkpoint sign/write error:', e);
          });
      }
    },
  });

  sessionHostEmit = (kind, data) => sessionHost.emit(kind, data);

  sessionHost.emit('session.start', recorderContext);

  if (recovery.kind === 'previous_session_corrupt') {
    sessionHost.emit('recorder.recovered_from_corruption', {
      quarantined_path: recovery.quarantinedPath,
    });
  }

  const hbDeps = deps.heartbeatDeps ?? defaultHeartbeatDeps();
  const heartbeat = startHeartbeat({
    ...hbDeps,
    getNow: () => clock.now(),
    emit: (data) => sessionHost.emit('session.heartbeat', data),
  });
  ownDisposables.push(heartbeat);

  const clockWatcher = startClockWatcher({
    getMonotonicMs: () => clock.now(),
    getWallMs: () => Date.now(),
    emit: (data) => sessionHost.emit('clock.skew', data),
  });
  ownDisposables.push(clockWatcher);

  const pasteIntercept = startPasteIntercept({
    registerCommand: (id, handler) => vscode.commands.registerCommand(id, handler),
    executeCommand: (id, ...args) => vscode.commands.executeCommand(id, ...args),
    getNow: () => clock.now(),
  });
  ownDisposables.push(pasteIntercept.disposable);

  let _largeInsertCount = 0;
  const largeInsertCounter: LargeInsertCounter = {
    increment() {
      _largeInsertCount++;
    },
    count() {
      return _largeInsertCount;
    },
  };

  const expectedContentRegistry = new ExpectedContentRegistry(manifest.files_under_review);
  const explanationTagger = new ExplanationTagger({ getNow: () => clock.now() });

  const toAssignmentRelative = makeAssignmentRelativePath(assignmentRoot);
  const prodReadFile = (relativePath: string): Promise<string> =>
    fsPromises.readFile(path.join(assignmentRoot, relativePath), 'utf8');
  const prodReadFileSync = (relativePath: string): string =>
    readFileSync(path.join(assignmentRoot, relativePath), 'utf8');

  const docWiring = startDocWiring({
    workspace: { asRelativePath: (uri) => toAssignmentRelative(uri.fsPath) },
    emitDocOpen: (data) => sessionHost.emit('doc.open', data),
    emitDocChange: (data) => sessionHost.emit('doc.change', data),
    emitDocSave: (data) => sessionHost.emit('doc.save', data),
    emitDocClose: (data) => sessionHost.emit('doc.close', data),
    emitPaste: (data) => sessionHost.emit('paste', data),
    emitSelectionChange: (data) => sessionHost.emit('selection.change', data),
    emitFocusChange: (data) => sessionHost.emit('focus.change', data),
    emitFsExternalChange: (data) => sessionHost.emit('fs.external_change', data),
    filesUnderReview: manifest.files_under_review,
    provenanceDir,
    expectedContent: expectedContentRegistry,
    pasteIntercept,
    largeInsertCounter,
    getNow: () => clock.now(),
    readFile: prodReadFile,
    readFileSync: prodReadFileSync,
    explanationTagger,
    isOwnedByThisRoot,
  });
  ownDisposables.push(docWiring);

  const fsWatcher = startFsWatcher({
    workspaceFolder: { uri: { fsPath: assignmentRoot } } as vscode.WorkspaceFolder,
    filesUnderReview: manifest.files_under_review,
    registry: expectedContentRegistry,
    emit: (data) => sessionHost.emit('fs.external_change', data),
    getLastDocChangeAt: (p) => docWiring.getLastDocChangeAt(p),
    getNow: () => clock.now(),
    readFile: prodReadFile,
    explanationTagger,
  });
  ownDisposables.push(fsWatcher);

  const reconciler = startPasteReconciler({
    emit: (data) => sessionHost.emit('paste.anomaly', data),
    getInterceptedCount: () => pasteIntercept.interceptCount,
    getLargeInsertCount: () => largeInsertCounter.count(),
  });
  ownDisposables.push(reconciler);

  type VscodeWindowExt = typeof vscode.window & {
    onDidStartTerminalShellExecution?: (
      h: (e: import('vscode').TerminalShellExecutionStartEvent) => void,
    ) => import('vscode').Disposable;
    onDidEndTerminalShellExecution?: (
      h: (e: import('vscode').TerminalShellExecutionEndEvent) => void,
    ) => import('vscode').Disposable;
  };
  const windowExt = vscode.window as VscodeWindowExt;
  const terminalWiringDeps = {
    emitTerminalOpen: (d: { terminal_id: string; shell: string; shell_integration: boolean }) =>
      sessionHost.emit('terminal.open', d),
    emitTerminalCommand: (d: { terminal_id: string; command: string; exit_code?: number }) =>
      sessionHost.emit('terminal.command', d),
    onDidOpenTerminal: (h: (t: import('vscode').Terminal) => void) =>
      vscode.window.onDidOpenTerminal(h),
    onDidCloseTerminal: (h: (t: import('vscode').Terminal) => void) =>
      vscode.window.onDidCloseTerminal(h),
    isOwnedByThisRoot,
    ...(windowExt.onDidStartTerminalShellExecution !== undefined
      ? {
          onDidStartTerminalShellExecution: (
            h: (e: import('vscode').TerminalShellExecutionStartEvent) => void,
          ) => windowExt.onDidStartTerminalShellExecution!(h),
        }
      : {}),
    ...(windowExt.onDidEndTerminalShellExecution !== undefined
      ? {
          onDidEndTerminalShellExecution: (
            h: (e: import('vscode').TerminalShellExecutionEndEvent) => void,
          ) => windowExt.onDidEndTerminalShellExecution!(h),
        }
      : {}),
  };
  const terminalWiring = startTerminalWiring(terminalWiringDeps);
  ownDisposables.push(terminalWiring);

  const snap = startExtensionSnapshot({
    emit: (d) => sessionHost.emit('ext.snapshot', d),
    getExtensions: () => vscode.extensions.all,
  });
  ownDisposables.push(snap);

  const extAct = startExtensionActivation({
    emit: (d) => sessionHost.emit('ext.activate', d),
    getExtensions: () => vscode.extensions.all,
  });
  ownDisposables.push(extAct);

  const gitW = startGitWiring({
    emit: (d) => sessionHost.emit('git.event', d),
    getGitExtension: () => vscode.extensions.getExtension('vscode.git'),
    explanationTagger,
    isOwnedByThisRoot,
  });
  ownDisposables.push(gitW);

  void computeExtensionHash; // referenced by the caller (extension.ts) at seal time, not here.

  async function dispose(): Promise<void> {
    try {
      sessionHost.emit('session.end', { reason: 'deactivate' });
    } catch {
      // Best effort.
    }
    try {
      await writer.dispose();
    } catch {
      // Best effort.
    }
    try {
      await pendingCheckpoint;
    } catch {
      // Best effort.
    }
    try {
      await metaWriter.dispose();
    } catch {
      // Best effort.
    }
    for (const d of [...ownDisposables].reverse()) {
      try {
        const result = d.dispose();
        if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
          await result;
        }
      } catch {
        // Best effort.
      }
    }
  }

  return {
    assignmentRoot,
    manifest,
    provenanceDir,
    slogPath,
    writer,
    metaWriter,
    sessionHost,
    sessionKeypair: { privateKey: keypair.privateKey, publicKeyHex: keypair.publicKeyHex },
    ownDisposables,
    getPendingCheckpoint: () => pendingCheckpoint,
    dispose,
  };
}
```

Note two forward-references that don't exist yet and must NOT break this task's build: `startDocWiring`'s deps gain an `isOwnedByThisRoot` field (Task 6), and `startTerminalWiring`/`startGitWiring` gain the same (Tasks 7-8). Since those tasks haven't run yet, **this task must add `isOwnedByThisRoot?: (fsPath: string) => boolean` as an accepted-but-ignored optional field on `DocWiringDeps`, `TerminalWiringDeps`, and `GitWiringDeps` right now** (a one-line addition to each type in `doc-wiring.ts`, `terminal-wiring.ts`, `git-wiring.ts`), so this task's own typecheck passes without yet implementing the filtering behavior — Tasks 6-8 then wire the field to actually do something. Make this explicit in this task's diff (it will show as a small addition in those three files alongside the main `session-registry.ts` extraction).

- [ ] **Step 4: Rewrite `extension.ts`'s `activateImpl` as a thin wrapper over `startSession`**

Replace `packages/recorder/src/extension.ts` lines 179-574 (the entire body of `activateImpl`, from the docstring through the closing `}`) with:

```ts
export async function activateImpl(deps: ActivateDeps): Promise<ActiveSession | null> {
  const { workspaceFolder, extension, vscodeVersion, platform, clock, disposables } = deps;

  activeSession = null;

  let manifest: Manifest;
  if (deps.preloadedManifest !== undefined) {
    manifest = deps.preloadedManifest;
  } else {
    const manifestResult = await loadAndVerifyManifest(workspaceFolder, deps.pubkeyHex);
    if (!manifestResult.ok) {
      console.error(`[provenance] activation skipped: ${manifestResult.error.kind}`);
      registerInactiveStub(disposables, manifestResult.error);
      return null;
    }
    manifest = manifestResult.value;
  }

  if (deps.createStatusBar !== undefined) {
    deps.createStatusBar(disposables);
  } else {
    createRecordingStatusBar(disposables);
  }

  const session = await startSession({
    assignmentRoot: workspaceFolder.uri.fsPath,
    manifest,
    extension,
    vscodeVersion,
    platform,
    clock,
    ...(deps.provenanceDirOverride !== undefined
      ? { provenanceDirOverride: deps.provenanceDirOverride }
      : {}),
    ...(deps.heartbeatDeps !== undefined ? { heartbeatDeps: deps.heartbeatDeps } : {}),
    ...(deps.extensionDistPath !== undefined ? { extensionDistPath: deps.extensionDistPath } : {}),
  });

  disposables.push(...session.ownDisposables);
  session.ownDisposables.length = 0; // now owned by `disposables`; avoid double-dispose from session.dispose().

  const extensionDistPath = deps.extensionDistPath ?? path.join(extension.extensionPath, 'dist');

  const sealCmd = vscode.commands.registerCommand(
    'provenance.prepareSubmissionBundle',
    async () => {
      await activeSession?.writer.flush();

      const result = await sealBundle({
        assignmentRoot: session.assignmentRoot,
        provenanceDir: session.provenanceDir,
        assignmentId: session.manifest.assignment_id,
        semester: session.manifest.semester,
        filesUnderReview: session.manifest.files_under_review,
        sessionPrivkey: session.sessionKeypair.privateKey,
        sessionPubkeyHex: session.sessionKeypair.publicKeyHex,
        computeExtensionHash: () => computeExtensionHash(extensionDistPath),
        now: () => new Date(),
      });

      if (result.kind === 'ok') {
        void vscode.window.showInformationMessage(
          `Provenance bundle saved to ${result.bundlePath}`,
        );
        if (result.warnings.chainBroken || result.warnings.unreadableSession) {
          void vscode.window.showWarningMessage(
            'Provenance bundle produced. Integrity issues were detected in the recording and will be reviewed by course staff.',
          );
        }
      } else if (result.kind === 'no_sessions') {
        void vscode.window.showWarningMessage('No session data to seal.');
      } else if (result.kind === 'write_error') {
        void vscode.window.showErrorMessage(`Bundle write error: ${result.message}`);
      }
    },
  );
  disposables.push(sealCmd);

  activeSession = session;
  return session;
}
```

Update `extension.ts`'s imports: remove everything now only used inside `session-registry.ts` (the long list from Step 3 above) EXCEPT what `activateImpl` itself still needs directly: `vscode`, `path`, `loadAndVerifyManifest`/`ActivationError`, `createRecordingStatusBar`, `sealBundle`, `computeExtensionHash`, and the `ActiveSession`/`startSession` import from `./session/session-registry.js`. Update the module-level `type ActiveSession = {...}` (extension.ts:104-111) to instead be `import type { ActiveSession } from './session/session-registry.js';` — delete the old inline type. `deactivate()` (extension.ts:656-696) becomes:

```ts
export async function deactivate(): Promise<void> {
  if (activeSession === null) {
    return;
  }
  const session = activeSession;
  activeSession = null;
  await session.dispose();
}
```

Note `session.dispose()` already does the `session.end` emit + writer flush + checkpoint drain + metaWriter dispose; it additionally disposes `ownDisposables`, which Step 4 above already zeroed out (`session.ownDisposables.length = 0`) since `disposables` (VS Code's own `context.subscriptions`) now owns and disposes those in LIFO order BEFORE `deactivate()` runs (matching the exact ordering comment that existed at extension.ts:559-564). This preserves the existing teardown order exactly.

- [ ] **Step 5: Run BOTH test suites to verify the extraction is behavior-preserving**

Run: `npm run test --workspace=packages/recorder -- session-registry activation.integration`
Expected: PASS — all cases in both `session-registry.test.ts` (new) and `activation.integration.test.ts` (untouched) pass. If `activation.integration.test.ts` fails, the extraction changed observable behavior — stop and fix before proceeding; do not weaken either test file's assertions.

- [ ] **Step 6: Typecheck + lint the whole recorder package**

Run: `npm run typecheck --workspace=packages/recorder && npm run lint`
Expected: no errors. (Verify no unused imports remain in `extension.ts` after the extraction — `tsc --noEmit` with `noUnusedLocals` should catch this if configured; otherwise ESLint's `no-unused-vars` will.)

- [ ] **Step 7: Commit**

```bash
git add packages/recorder/src/session/session-registry.ts packages/recorder/src/session/session-registry.test.ts packages/recorder/src/extension.ts packages/recorder/src/wiring/doc-wiring.ts packages/recorder/src/wiring/terminal-wiring.ts packages/recorder/src/wiring/git-wiring.ts
git commit --no-gpg-sign -m "refactor(recorder): extract per-assignment-root session activation"
```

---

## Task 5: `SessionRegistry` + multi-session discovery wiring in `extension.ts`

**Files:**
- Modify: `packages/recorder/src/session/session-registry.ts` (add `SessionRegistry` class)
- Modify: `packages/recorder/src/extension.ts` (rewrite `activate()` to discover N manifests and start N sessions via `SessionRegistry`; `deactivate()` disposes all)
- Test: `packages/recorder/src/session/session-registry.test.ts` (append `SessionRegistry` cases)
- Modify: `packages/recorder/src/activation/activation.integration.test.ts` (add multi-session discovery cases; this is where acceptance criteria #1 and #6 get their end-to-end coverage)

**Interfaces:**
- Consumes: `startSession`, `ActiveSession` (Task 4); `discoverManifests` (Task 1); `resolveOwnerRoot` (Task 2).
- Produces:
  ```ts
  export class SessionRegistry {
    constructor();
    get(root: string): ActiveSession | undefined;
    all(): readonly ActiveSession[];
    add(session: ActiveSession): void;
    resolveForPath(fsPath: string): ActiveSession | undefined;
    /** Disposes and removes any session whose root is not contained by any of currentRoots. */
    pruneToRoots(currentRoots: readonly string[]): Promise<void>;
    disposeAll(): Promise<void>;
  }
  ```

- [ ] **Step 1: Write the failing `SessionRegistry` unit tests**

Append to `packages/recorder/src/session/session-registry.test.ts`:

```ts
describe('SessionRegistry', () => {
  it('resolveForPath routes to the nearest-ancestor session', async () => {
    const registry = new SessionRegistry();
    const fakeSession = (root: string): ActiveSession =>
      ({ assignmentRoot: root, dispose: async () => {} }) as unknown as ActiveSession;

    const cats = path.join('/ws', '61a', 'cats');
    const hog = path.join('/ws', '61a', 'hog');
    registry.add(fakeSession(cats));
    registry.add(fakeSession(hog));

    expect(registry.resolveForPath(path.join(cats, 'x.py'))?.assignmentRoot).toBe(cats);
    expect(registry.resolveForPath(path.join(hog, 'y.py'))?.assignmentRoot).toBe(hog);
    expect(registry.resolveForPath(path.join('/ws', '61a', 'notes.md'))).toBeUndefined();
  });

  it('all() returns every added session; get() looks up by exact root', () => {
    const registry = new SessionRegistry();
    const fakeSession = (root: string): ActiveSession =>
      ({ assignmentRoot: root, dispose: async () => {} }) as unknown as ActiveSession;
    const a = fakeSession('/ws/a');
    const b = fakeSession('/ws/b');
    registry.add(a);
    registry.add(b);

    expect(registry.all()).toEqual([a, b]);
    expect(registry.get('/ws/a')).toBe(a);
    expect(registry.get('/ws/missing')).toBeUndefined();
  });

  it('disposeAll() disposes every session and empties the registry', async () => {
    const registry = new SessionRegistry();
    let disposedCount = 0;
    const fakeSession = (root: string): ActiveSession =>
      ({
        assignmentRoot: root,
        dispose: async () => {
          disposedCount++;
        },
      }) as unknown as ActiveSession;
    registry.add(fakeSession('/ws/a'));
    registry.add(fakeSession('/ws/b'));

    await registry.disposeAll();

    expect(disposedCount).toBe(2);
    expect(registry.all()).toEqual([]);
  });

  it('pruneToRoots disposes sessions no longer under any current root', async () => {
    const registry = new SessionRegistry();
    let disposed: string[] = [];
    const fakeSession = (root: string): ActiveSession =>
      ({
        assignmentRoot: root,
        dispose: async () => {
          disposed.push(root);
        },
      }) as unknown as ActiveSession;
    const kept = path.join('/ws', 'keep');
    const removed = path.join('/ws', 'removed');
    registry.add(fakeSession(kept));
    registry.add(fakeSession(removed));

    await registry.pruneToRoots([path.join('/ws', 'keep')]);

    expect(disposed).toEqual([removed]);
    expect(registry.all().map((s) => s.assignmentRoot)).toEqual([kept]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace=packages/recorder -- session-registry`
Expected: FAIL — `SessionRegistry` is not exported yet.

- [ ] **Step 3: Implement `SessionRegistry`**

Append to `packages/recorder/src/session/session-registry.ts` (after `startSession`):

```ts
// ---------------------------------------------------------------------------
// SessionRegistry
// ---------------------------------------------------------------------------

import { resolveOwnerRoot } from './session-router.js';

/** Owns every currently-active ActiveSession, keyed by assignmentRoot. */
export class SessionRegistry {
  private readonly sessions = new Map<string, ActiveSession>();

  add(session: ActiveSession): void {
    this.sessions.set(session.assignmentRoot, session);
  }

  get(root: string): ActiveSession | undefined {
    return this.sessions.get(root);
  }

  all(): readonly ActiveSession[] {
    return [...this.sessions.values()];
  }

  resolveForPath(fsPath: string): ActiveSession | undefined {
    const root = resolveOwnerRoot(fsPath, [...this.sessions.keys()]);
    return root === null ? undefined : this.sessions.get(root);
  }

  async pruneToRoots(currentRoots: readonly string[]): Promise<void> {
    const toRemove: string[] = [];
    for (const root of this.sessions.keys()) {
      if (resolveOwnerRoot(root, currentRoots) === null) {
        toRemove.push(root);
      }
    }
    for (const root of toRemove) {
      const session = this.sessions.get(root);
      this.sessions.delete(root);
      if (session !== undefined) {
        await session.dispose();
      }
    }
  }

  async disposeAll(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    for (const session of sessions) {
      await session.dispose();
    }
  }
}
```

Move the `import { resolveOwnerRoot } from './session-router.js';` line up to the top-level import block with the rest of the file's imports (it's shown inline above only to mark where it's newly needed relative to Task 4's version of the file).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test --workspace=packages/recorder -- session-registry`
Expected: PASS (all `startSession` tests from Task 4 + the 4 new `SessionRegistry` tests).

- [ ] **Step 5: Rewrite `extension.ts`'s `activate()` for multi-session discovery**

Replace `packages/recorder/src/extension.ts`'s `activate()` function (currently lines 597-654) with:

```ts
const registry = new SessionRegistry();

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    return;
  }

  const ownExtension = vscode.extensions.getExtension('itsgeagle.provenance-recorder');
  if (ownExtension === undefined) {
    console.error(
      '[provenance] WARNING: could not locate own extension via getExtension; using context fallback.',
    );
  }
  const extension: vscode.Extension<unknown> =
    ownExtension ??
    ({
      id: 'itsgeagle.provenance-recorder',
      extensionUri: context.extensionUri,
      extensionPath: context.extensionPath,
      isActive: true,
      packageJSON: { version: '0.0.0', publisher: 'itsgeagle', name: 'provenance-recorder' },
      exports: undefined,
      activate: () => Promise.resolve(undefined),
      extensionKind: vscode.ExtensionKind.Workspace,
    } as vscode.Extension<unknown>);

  const extensionDistPath = path.join(context.extensionPath, 'dist');

  try {
    const { found, skipped } = await discoverManifests({
      workspaceFolders,
      findFiles: (include, exclude) => vscode.workspace.findFiles(include, exclude),
    });

    for (const skip of skipped) {
      console.error(`[provenance] activation skipped for ${skip.root}: ${skip.error.kind}`);
    }

    if (found.length === 0) {
      // No verified manifest anywhere — register the inactive stub once, using the
      // first skip reason if any, else a synthetic no_manifest_file (mirrors the
      // pre-nested-discovery single-root "nothing found" case).
      const reason: ActivationError = skipped[0]?.error ?? { kind: 'no_manifest_file' };
      registerInactiveStub(context.subscriptions, reason);
      return;
    }

    if (found.length > 0) {
      createRecordingStatusBar(context.subscriptions);
    }

    for (const { root, manifest } of found) {
      const session = await startSession({
        assignmentRoot: root,
        manifest,
        extension,
        vscodeVersion: vscode.version,
        platform: `${process.platform}-${process.arch}`,
        clock: new SystemClock(),
        extensionDistPath,
        isOwnedByThisRoot: (fsPath: string) =>
          resolveOwnerRoot(fsPath, found.map((f) => f.root)) === root,
      });
      context.subscriptions.push(...session.ownDisposables);
      session.ownDisposables.length = 0;
      registry.add(session);
    }

    registerSealCommand(context, extensionDistPath);

    context.subscriptions.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        void rescan(context, extensionDistPath, extension);
      }),
    );
  } catch (e) {
    console.error('[provenance] unexpected error during activation:', e);
  }
}

async function rescan(
  context: vscode.ExtensionContext,
  extensionDistPath: string,
  extension: vscode.Extension<unknown>,
): Promise<void> {
  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
  const currentRoots = workspaceFolders.map((f) => f.uri.fsPath);

  // Stop sessions whose root left the workspace.
  await registry.pruneToRoots(currentRoots);

  // Start sessions for any newly-discovered root not already active.
  const { found } = await discoverManifests({
    workspaceFolders,
    findFiles: (include, exclude) => vscode.workspace.findFiles(include, exclude),
  });
  const allRoots = found.map((f) => f.root);

  for (const { root, manifest } of found) {
    if (registry.get(root) !== undefined) continue;
    const session = await startSession({
      assignmentRoot: root,
      manifest,
      extension,
      vscodeVersion: vscode.version,
      platform: `${process.platform}-${process.arch}`,
      clock: new SystemClock(),
      extensionDistPath,
      isOwnedByThisRoot: (fsPath: string) => resolveOwnerRoot(fsPath, allRoots) === root,
    });
    context.subscriptions.push(...session.ownDisposables);
    session.ownDisposables.length = 0;
    registry.add(session);
  }
}
```

Add the two new imports at the top of `extension.ts`: `import { discoverManifests } from './activation/manifest-discovery.js';` and `import { resolveOwnerRoot } from './session/session-router.js';` and `import { SessionRegistry } from './session/session-registry.js';` (alongside the already-updated `startSession`/`ActiveSession` import from Task 4). Note `registerInactiveStub` and `ActivationError` imports are unchanged from today.

`registerSealCommand` is a new small helper extracted from what used to be inline in `activateImpl` — Task 9 (seal selector) implements its body; for THIS task, stub it minimally so the file compiles and the single/no-selector case behaves identically to before:

```ts
function registerSealCommand(context: vscode.ExtensionContext, extensionDistPath: string): void {
  const sealCmd = vscode.commands.registerCommand(
    'provenance.prepareSubmissionBundle',
    async () => {
      const sessions = registry.all();
      if (sessions.length === 0) {
        void vscode.window.showWarningMessage('No session data to seal.');
        return;
      }
      const chosen = sessions[0]!; // Task 9 replaces this with a QuickPick when sessions.length > 1.
      await chosen.writer.flush();

      const result = await sealBundle({
        assignmentRoot: chosen.assignmentRoot,
        provenanceDir: chosen.provenanceDir,
        assignmentId: chosen.manifest.assignment_id,
        semester: chosen.manifest.semester,
        filesUnderReview: chosen.manifest.files_under_review,
        sessionPrivkey: chosen.sessionKeypair.privateKey,
        sessionPubkeyHex: chosen.sessionKeypair.publicKeyHex,
        computeExtensionHash: () => computeExtensionHash(extensionDistPath),
        now: () => new Date(),
      });

      if (result.kind === 'ok') {
        void vscode.window.showInformationMessage(
          `Provenance bundle saved to ${result.bundlePath}`,
        );
        if (result.warnings.chainBroken || result.warnings.unreadableSession) {
          void vscode.window.showWarningMessage(
            'Provenance bundle produced. Integrity issues were detected in the recording and will be reviewed by course staff.',
          );
        }
      } else if (result.kind === 'no_sessions') {
        void vscode.window.showWarningMessage('No session data to seal.');
      } else if (result.kind === 'write_error') {
        void vscode.window.showErrorMessage(`Bundle write error: ${result.message}`);
      }
    },
  );
  context.subscriptions.push(sealCmd);
}
```

Rewrite `deactivate()`:

```ts
export async function deactivate(): Promise<void> {
  await registry.disposeAll();
}
```

Note: `activateImpl` (Task 4's thin wrapper, still exported for the single-session unit tests in `activation.integration.test.ts`) and the module-level `activeSession` variable it uses are now **only** exercised by that one legacy test file's direct calls — `activate()`/`deactivate()` (the real VS Code entrypoints) no longer call `activateImpl` at all as of this step. Keep `activateImpl` exported and working (do not delete it — Task 4's tests and `activation.integration.test.ts` depend on it), but it is understood to be a single-session-only code path retained for that test file's existing coverage, not the production entrypoint anymore. Flag this explicitly to the reviewer in this task's commit message body.

- [ ] **Step 6: Extend `activation.integration.test.ts` with multi-session discovery coverage**

Since `activate()`/`deactivate()` now do real `vscode.workspace.findFiles`-based discovery and aren't easily unit-testable without a real Extension Host (no seam for injecting `discoverManifests`/`findFiles` into the module-level `activate()` function), add these end-to-end cases against `startSession` + `SessionRegistry` + `discoverManifests` composed directly (mirroring what `activate()` does), rather than against `activate()` itself — this is the same test-the-composition-not-the-VS-Code-glue approach the rest of this file already uses. Append to `packages/recorder/src/activation/activation.integration.test.ts`:

```ts
describe('multi-session discovery (nested manifests)', () => {
  it('two nested manifests under one opened folder yield two independent sessions', async () => {
    const { pubkeyHex, privkeyHex } = await generateTestKeypair();
    const catsFields = {
      assignment_id: 'cats',
      semester: 'fa26',
      issued_at: '2026-01-01T00:00:00Z',
      files_under_review: ['hw.py'],
    };
    const hogFields = {
      assignment_id: 'hog',
      semester: 'fa26',
      issued_at: '2026-01-01T00:00:00Z',
      files_under_review: ['hw.py'],
    };
    const catsSig = await signManifest(catsFields, privkeyHex);
    const hogSig = await signManifest(hogFields, privkeyHex);

    const catsDir = path.join(workspaceDir, 'cats');
    const hogDir = path.join(workspaceDir, 'hog');
    await fs.mkdir(catsDir, { recursive: true });
    await fs.mkdir(hogDir, { recursive: true });
    await fs.writeFile(
      path.join(catsDir, '.provenance-manifest'),
      JSON.stringify({ ...catsFields, sig: catsSig }),
      'utf8',
    );
    await fs.writeFile(
      path.join(hogDir, '.provenance-manifest'),
      JSON.stringify({ ...hogFields, sig: hogSig }),
      'utf8',
    );

    const { discoverManifests } = await import('./manifest-discovery.js');
    const { startSession, SessionRegistry } = await import('../session/session-registry.js');

    const { found, skipped } = await discoverManifests({
      workspaceFolders: [{ uri: { fsPath: workspaceDir } }],
      findFiles: async () => [
        { fsPath: path.join(catsDir, '.provenance-manifest') },
        { fsPath: path.join(hogDir, '.provenance-manifest') },
      ],
      pubkeyHex,
    });

    expect(skipped).toEqual([]);
    expect(found.map((f) => f.root).sort()).toEqual([catsDir, hogDir].sort());

    const clock = new FixedClock(0, new Date('2026-01-01T00:00:00.000Z'));
    const registry = new SessionRegistry();
    for (const { root, manifest } of found) {
      const session = await startSession({
        assignmentRoot: root,
        manifest,
        extension: makeExtension(),
        vscodeVersion: '1.97.0',
        platform: 'darwin-arm64',
        clock,
      });
      registry.add(session);
    }

    expect(registry.all()).toHaveLength(2);
    expect(registry.resolveForPath(path.join(catsDir, 'x.py'))?.assignmentRoot).toBe(catsDir);
    expect(registry.resolveForPath(path.join(hogDir, 'y.py'))?.assignmentRoot).toBe(hogDir);
    expect(registry.resolveForPath(path.join(workspaceDir, 'notes.md'))).toBeUndefined();

    await registry.disposeAll();
  });

  it('a manifest at the opened root still yields exactly one session (regression)', async () => {
    const { pubkeyHex, privkeyHex } = await generateTestKeypair();
    const fields = {
      assignment_id: 'hw03',
      semester: 'fa26',
      issued_at: '2026-01-01T00:00:00Z',
      files_under_review: ['hw.py'],
    };
    const sig = await signManifest(fields, privkeyHex);
    await fs.writeFile(
      path.join(workspaceDir, '.provenance-manifest'),
      JSON.stringify({ ...fields, sig }),
      'utf8',
    );

    const { discoverManifests } = await import('./manifest-discovery.js');
    const { found, skipped } = await discoverManifests({
      workspaceFolders: [{ uri: { fsPath: workspaceDir } }],
      findFiles: async () => [{ fsPath: path.join(workspaceDir, '.provenance-manifest') }],
      pubkeyHex,
    });

    expect(skipped).toEqual([]);
    expect(found).toHaveLength(1);
    expect(found[0]?.root).toBe(workspaceDir);
  });

  it('a folder with no manifest anywhere yields no sessions', async () => {
    const { pubkeyHex } = await generateTestKeypair();
    const { discoverManifests } = await import('./manifest-discovery.js');
    const { found, skipped } = await discoverManifests({
      workspaceFolders: [{ uri: { fsPath: workspaceDir } }],
      findFiles: async () => [],
      pubkeyHex,
    });
    expect(found).toEqual([]);
    expect(skipped).toEqual([]);
  });
});
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npm run test --workspace=packages/recorder -- session-registry activation.integration`
Expected: PASS (all cases, old and new).

- [ ] **Step 8: Typecheck + lint**

Run: `npm run typecheck --workspace=packages/recorder && npm run lint`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add packages/recorder/src/session/session-registry.ts packages/recorder/src/session/session-registry.test.ts packages/recorder/src/extension.ts packages/recorder/src/activation/activation.integration.test.ts
git commit --no-gpg-sign -m "feat(recorder): wire multi-session discovery through SessionRegistry"
```

---

## Task 6: Doc-wiring ownership filter + assignment-relative paths

**Files:**
- Modify: `packages/recorder/src/wiring/doc-wiring.ts`
- Test: `packages/recorder/src/wiring/doc-wiring.test.ts`

**Interfaces:**
- Consumes: `isOwnedByThisRoot?: (fsPath: string) => boolean` field already added to `DocWiringDeps` as a compile-time stub in Task 4.
- Produces: `isRecordable()` now additionally requires ownership; unowned files never reach any emit callback.

- [ ] **Step 1: Write the failing test**

Read the existing `packages/recorder/src/wiring/doc-wiring.test.ts` first to match its existing mock-`workspace`/mock-`vscode` fixture patterns (this file already has extensive fixtures for `isRecordable`-adjacent behavior — reuse them). Append a new `describe` block:

```ts
describe('isOwnedByThisRoot filter', () => {
  it('drops doc.open for a file this session does not own', () => {
    const emitDocOpen = vi.fn();
    // Reuse this file's existing harness (buildDeps / makeDocument helpers already
    // defined above) but pass isOwnedByThisRoot: () => false.
    const deps = buildDeps({ emitDocOpen, isOwnedByThisRoot: () => false });
    const handle = startDocWiring(deps);
    const doc = makeDocument('/ws/61a/hog/y.py');
    triggerOpen(doc); // however this file's harness fires onDidOpenTextDocument
    expect(emitDocOpen).not.toHaveBeenCalled();
    handle.dispose();
  });

  it('emits doc.open for a file this session owns', () => {
    const emitDocOpen = vi.fn();
    const deps = buildDeps({ emitDocOpen, isOwnedByThisRoot: () => true });
    const handle = startDocWiring(deps);
    const doc = makeDocument('/ws/61a/cats/x.py');
    triggerOpen(doc);
    expect(emitDocOpen).toHaveBeenCalledOnce();
    handle.dispose();
  });

  it('defaults to owning everything when isOwnedByThisRoot is omitted (regression)', () => {
    const emitDocOpen = vi.fn();
    const deps = buildDeps({ emitDocOpen }); // no isOwnedByThisRoot
    const handle = startDocWiring(deps);
    const doc = makeDocument('/ws/hw03/hw.py');
    triggerOpen(doc);
    expect(emitDocOpen).toHaveBeenCalledOnce();
    handle.dispose();
  });
});
```

Adapt the exact helper names (`buildDeps`, `makeDocument`, `triggerOpen`) to whatever this file's existing harness is actually called — read the file's current top section before writing this step for real, and reuse its vscode-mock plumbing verbatim rather than inventing new mock shapes.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace=packages/recorder -- doc-wiring`
Expected: FAIL — `isOwnedByThisRoot` isn't consulted by `isRecordable` yet (all three new cases either fail or the first two pass vacuously; confirm the failure is meaningful, not a fixture mistake).

- [ ] **Step 3: Wire the filter into `isRecordable`**

In `packages/recorder/src/wiring/doc-wiring.ts`, add to `DocWiringDeps` (this field already exists as a stub per Task 4 — confirm it's there; if not, add it now):

```ts
  /**
   * Ownership filter (spec Design §3): returns true if the given absolute fsPath
   * belongs to THIS session's assignment root (per nearest-ancestor resolution —
   * see session/session-router.ts). Defaults to "always owned" so single-session
   * callers/tests that don't care about multi-root routing need not supply it.
   */
  isOwnedByThisRoot?: (fsPath: string) => boolean;
```

Destructure it in `startDocWiring` (near the other destructured deps, line ~123-141):

```ts
  const isOwnedByThisRoot = deps.isOwnedByThisRoot ?? (() => true);
```

Modify `isRecordable` (lines 205-211) to additionally check ownership:

```ts
  function isRecordable(uri: { fsPath: string; scheme: string }): boolean {
    if (uri.scheme !== 'file') return false;
    const rel = workspace.asRelativePath(uri as import('vscode').Uri);
    if (rel === uri.fsPath) return false;
    if (isProvenanceArtifact(uri.fsPath, rel)) return false;
    if (!isOwnedByThisRoot(uri.fsPath)) return false;
    return true;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test --workspace=packages/recorder -- doc-wiring`
Expected: PASS (all existing cases + 3 new).

- [ ] **Step 5: Typecheck + lint**

Run: `npm run typecheck --workspace=packages/recorder && npm run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/recorder/src/wiring/doc-wiring.ts packages/recorder/src/wiring/doc-wiring.test.ts
git commit --no-gpg-sign -m "feat(recorder): gate doc-wiring events on assignment-root ownership"
```

---

## Task 7: fs-watcher — assignmentRoot base path (mechanical — `haiku` OK)

**Files:**
- Modify: `packages/recorder/src/wiring/fs-watcher.ts`
- Test: `packages/recorder/src/wiring/fs-watcher.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `FsWatcherDeps.workspaceFolder: vscode.WorkspaceFolder` → `FsWatcherDeps.assignmentRoot: string`; the caller (`session-registry.ts`, Task 4) currently passes a cast `{ uri: { fsPath: assignmentRoot } } as vscode.WorkspaceFolder` — this task removes that cast.

- [ ] **Step 1: Update the failing/adjusted test expectations**

Read `packages/recorder/src/wiring/fs-watcher.test.ts` fully first. Every place it currently constructs a `workspaceFolder: { uri: { fsPath: ... }, name: ..., index: 0 }` fixture to pass as `FsWatcherDeps.workspaceFolder`, change the fixture to instead pass `assignmentRoot: '<the same fsPath string>'` directly. This is a mechanical rename across the test file's `startFsWatcher({...})` call sites — do not change any assertions, only the deps shape.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace=packages/recorder -- fs-watcher`
Expected: FAIL — `assignmentRoot` is not a recognized field yet (TS error surfaces as a test run failure since ts-node/vitest will fail to compile).

- [ ] **Step 3: Update `FsWatcherDeps` and the `RelativePattern` construction**

In `packages/recorder/src/wiring/fs-watcher.ts`, change `FsWatcherDeps` (lines 48-61):

```ts
export type FsWatcherDeps = {
  assignmentRoot: string;
  filesUnderReview: readonly string[];
  registry: ExpectedContentRegistry;
  emit: (data: FsExternalChangeData) => void;
  getLastDocChangeAt: (path: string) => number;
  getNow: () => number;
  recentDocChangeToleranceMs?: number;
  readFile: (relativePath: string) => Promise<string>;
  explanationTagger?: ExplanationTagger;
};
```

Update destructuring (line 72-81) to use `assignmentRoot` instead of `workspaceFolder`, and change the `RelativePattern` construction (line 87):

```ts
    const pattern = new vscode.RelativePattern(assignmentRoot, relativePath);
```

(`vscode.RelativePattern`'s constructor accepts `base: WorkspaceFolder | Uri | string`, so a plain string root works unchanged.)

- [ ] **Step 4: Update the `session-registry.ts` call site**

In `packages/recorder/src/session/session-registry.ts` (from Task 4), change the `startFsWatcher` call's first field from:

```ts
    workspaceFolder: { uri: { fsPath: assignmentRoot } } as vscode.WorkspaceFolder,
```

to:

```ts
    assignmentRoot,
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test --workspace=packages/recorder -- fs-watcher session-registry`
Expected: PASS.

- [ ] **Step 6: Typecheck + lint**

Run: `npm run typecheck --workspace=packages/recorder && npm run lint`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/recorder/src/wiring/fs-watcher.ts packages/recorder/src/wiring/fs-watcher.test.ts packages/recorder/src/session/session-registry.ts
git commit --no-gpg-sign -m "refactor(recorder): scope fs-watcher RelativePattern to assignmentRoot"
```

---

## Task 8: seal.ts — assignmentRoot param rename (mechanical — `haiku` OK)

**Files:**
- Modify: `packages/recorder/src/commands/seal.ts`
- Test: `packages/recorder/src/commands/seal.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `SealDeps.workspaceFolder: vscode.WorkspaceFolder` → `SealDeps.assignmentRoot: string`. (Already called with the new shape by Task 4's/5's `sealBundle({...})` call sites in `extension.ts` — this task makes `seal.ts` itself match.)

- [ ] **Step 1: Update the failing test fixtures**

Read `packages/recorder/src/commands/seal.test.ts` fully first. Every `sealBundle({ workspaceFolder: {...}, ... })` call site: replace `workspaceFolder: { uri: { fsPath: X }, ... }` with `assignmentRoot: X`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace=packages/recorder -- seal`
Expected: FAIL (type mismatch surfaces as a compile/test failure).

- [ ] **Step 3: Update `SealDeps` and internal usage**

In `packages/recorder/src/commands/seal.ts`, change `SealDeps` (lines 57-77):

```ts
export type SealDeps = {
  assignmentRoot: string;
  provenanceDir: string;
  assignmentId: string;
  semester: string;
  filesUnderReview: readonly string[];
  sessionPrivkey: Uint8Array;
  sessionPubkeyHex: string;
  computeExtensionHash: () => Promise<string>;
  outputDir?: string;
  now: () => Date;
};
```

Update `sealBundle`'s destructuring (lines 174-184) and body: replace `workspaceFolder` with `assignmentRoot`, and change:

```ts
  const workspaceRoot = workspaceFolder.uri.fsPath;
```
to
```ts
  const workspaceRoot = assignmentRoot;
```

and:
```ts
  const resolvedOutputDir = outputDir ?? workspaceFolder.uri.fsPath;
```
to
```ts
  const resolvedOutputDir = outputDir ?? assignmentRoot;
```

Remove the now-unused `import * as vscode from 'vscode';` at the top of the file if nothing else in `seal.ts` references `vscode` after this change (grep the file for `vscode\.` first to confirm).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test --workspace=packages/recorder -- seal`
Expected: PASS.

- [ ] **Step 5: Typecheck + lint**

Run: `npm run typecheck --workspace=packages/recorder && npm run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/recorder/src/commands/seal.ts packages/recorder/src/commands/seal.test.ts
git commit --no-gpg-sign -m "refactor(recorder): rename sealBundle's workspaceFolder param to assignmentRoot"
```

---

## Task 9: Terminal cwd resolution + ownership routing

**Files:**
- Modify: `packages/recorder/src/wiring/terminal-wiring.ts`
- Test: `packages/recorder/src/wiring/terminal-wiring.test.ts`

**Interfaces:**
- Consumes: `isOwnedByThisRoot?: (fsPath: string) => boolean` field already stubbed onto `TerminalWiringDeps` in Task 4.
- Produces: terminal.open / terminal.command are only emitted when the terminal's resolved cwd is owned by this session; both events are dropped (not just command) when cwd can't be determined at all and no fallback resolves — matching the spec's "route by cwd; drop if no owner."

**Design note (locked from research during planning):** `vscode.Terminal` exposes two cwd sources: `terminal.creationOptions` (a `TerminalOptions | ExtensionTerminalOptions` union) may have a static `cwd?: string | Uri` set at creation time (often `undefined`, defaulting to the workspace root VS Code picked); `terminal.shellIntegration?.cwd` (a `Uri | undefined`) is live-updated by shell integration and reflects the terminal's *actual current* working directory (accounts for `cd` commands), when shell integration is available (VS Code 1.93+, same feature gate already used for `onDidStartTerminalShellExecution`). Resolution order: prefer `shellIntegration.cwd` (most accurate, most likely to exist by the time a command runs); fall back to `creationOptions.cwd` (resolve if it's a `Uri`, use directly if it's a `string`); if neither exists, treat cwd as unknown and drop the event (spec: "if no assignment root owns it, drop").

- [ ] **Step 1: Write the failing test**

Read `packages/recorder/src/wiring/terminal-wiring.test.ts` fully first to reuse its existing `Terminal`/`TerminalShellExecution` mock fixtures. Append:

```ts
describe('cwd-based ownership routing', () => {
  function makeTerminal(opts: { cwd?: string; shellIntegrationCwd?: string }): import('vscode').Terminal {
    return {
      creationOptions: opts.cwd !== undefined ? { cwd: opts.cwd } : {},
      shellIntegration:
        opts.shellIntegrationCwd !== undefined
          ? ({ cwd: { fsPath: opts.shellIntegrationCwd } } as import('vscode').Uri as never)
          : undefined,
    } as unknown as import('vscode').Terminal;
  }

  it('emits terminal.open when the terminal cwd (via creationOptions) is owned', () => {
    const emitTerminalOpen = vi.fn();
    let openHandler: ((t: import('vscode').Terminal) => void) | undefined;
    startTerminalWiring({
      emitTerminalOpen,
      emitTerminalCommand: vi.fn(),
      onDidOpenTerminal: (h) => {
        openHandler = h;
        return { dispose() {} };
      },
      onDidCloseTerminal: () => ({ dispose() {} }),
      isOwnedByThisRoot: (fsPath) => fsPath === '/ws/cats',
    });
    openHandler!(makeTerminal({ cwd: '/ws/cats' }));
    expect(emitTerminalOpen).toHaveBeenCalledOnce();
  });

  it('drops terminal.open when the resolved cwd is owned by no session', () => {
    const emitTerminalOpen = vi.fn();
    let openHandler: ((t: import('vscode').Terminal) => void) | undefined;
    startTerminalWiring({
      emitTerminalOpen,
      emitTerminalCommand: vi.fn(),
      onDidOpenTerminal: (h) => {
        openHandler = h;
        return { dispose() {} };
      },
      onDidCloseTerminal: () => ({ dispose() {} }),
      isOwnedByThisRoot: (fsPath) => fsPath === '/ws/cats',
    });
    openHandler!(makeTerminal({ cwd: '/ws/parent' }));
    expect(emitTerminalOpen).not.toHaveBeenCalled();
  });

  it('drops terminal.open when cwd cannot be determined at all', () => {
    const emitTerminalOpen = vi.fn();
    let openHandler: ((t: import('vscode').Terminal) => void) | undefined;
    startTerminalWiring({
      emitTerminalOpen,
      emitTerminalCommand: vi.fn(),
      onDidOpenTerminal: (h) => {
        openHandler = h;
        return { dispose() {} };
      },
      onDidCloseTerminal: () => ({ dispose() {} }),
      isOwnedByThisRoot: () => true, // even an "owns everything" filter can't help with unknown cwd
    });
    openHandler!(makeTerminal({}));
    expect(emitTerminalOpen).not.toHaveBeenCalled();
  });

  it('prefers shellIntegration.cwd over creationOptions.cwd when both are present', () => {
    const emitTerminalOpen = vi.fn();
    let openHandler: ((t: import('vscode').Terminal) => void) | undefined;
    startTerminalWiring({
      emitTerminalOpen,
      emitTerminalCommand: vi.fn(),
      onDidOpenTerminal: (h) => {
        openHandler = h;
        return { dispose() {} };
      },
      onDidCloseTerminal: () => ({ dispose() {} }),
      isOwnedByThisRoot: (fsPath) => fsPath === '/ws/hog', // only the shellIntegration cwd is owned
    });
    openHandler!(makeTerminal({ cwd: '/ws/cats', shellIntegrationCwd: '/ws/hog' }));
    expect(emitTerminalOpen).toHaveBeenCalledOnce();
  });

  it('defaults to owning everything when isOwnedByThisRoot is omitted, as long as cwd resolves (regression)', () => {
    const emitTerminalOpen = vi.fn();
    let openHandler: ((t: import('vscode').Terminal) => void) | undefined;
    startTerminalWiring({
      emitTerminalOpen,
      emitTerminalCommand: vi.fn(),
      onDidOpenTerminal: (h) => {
        openHandler = h;
        return { dispose() {} };
      },
      onDidCloseTerminal: () => ({ dispose() {} }),
    });
    openHandler!(makeTerminal({ cwd: '/ws/hw03' }));
    expect(emitTerminalOpen).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace=packages/recorder -- terminal-wiring`
Expected: FAIL — no cwd resolution/filtering exists yet.

- [ ] **Step 3: Implement cwd resolution + filtering**

In `packages/recorder/src/wiring/terminal-wiring.ts`, add to `TerminalWiringDeps` (this field is already stubbed by Task 4 — confirm/add):

```ts
  /** Ownership filter by resolved terminal cwd. Defaults to "always owned". */
  isOwnedByThisRoot?: (fsPath: string) => boolean;
```

Add a resolver function and use it to guard both `emitTerminalOpen` and the command-capture path:

```ts
/**
 * Resolve a terminal's current working directory, preferring shell-integration's
 * live-updated cwd (accounts for `cd`) over the static creationOptions.cwd set at
 * terminal-creation time. Returns undefined if neither is available.
 */
function resolveTerminalCwd(terminal: vscode.Terminal): string | undefined {
  const shellCwd = terminal.shellIntegration?.cwd;
  if (shellCwd !== undefined) {
    return shellCwd.fsPath;
  }
  const creationCwd = (terminal.creationOptions as { cwd?: string | vscode.Uri } | undefined)?.cwd;
  if (creationCwd === undefined) {
    return undefined;
  }
  return typeof creationCwd === 'string' ? creationCwd : creationCwd.fsPath;
}
```

In `startTerminalWiring`, destructure `isOwnedByThisRoot` (default `() => true`) and gate both subscriptions:

```ts
  const isOwnedByThisRoot = deps.isOwnedByThisRoot ?? (() => true);

  function isTerminalOwned(terminal: vscode.Terminal): boolean {
    const cwd = resolveTerminalCwd(terminal);
    return cwd !== undefined && isOwnedByThisRoot(cwd);
  }
```

Update the `openSub` handler (line 76-83):

```ts
  const openSub = onDidOpenTerminal((terminal) => {
    if (!isTerminalOwned(terminal)) return;
    const terminal_id = assignId(terminal);
    const creationOptions = terminal.creationOptions as { shellPath?: string } | undefined;
    const shell = creationOptions?.shellPath ?? 'unknown';
    const shell_integration = terminal.shellIntegration !== undefined;

    emitTerminalOpen({ terminal_id, shell, shell_integration });
  });
```

Update the `startSub`/`endSub` handlers (lines 99-123) to check ownership via `event.terminal`:

```ts
    const startSub = onDidStartTerminalShellExecution((event) => {
      if (!isTerminalOwned(event.terminal)) return;
      const terminal_id = assignId(event.terminal);
      const commandLine = event.execution.commandLine;
      const command = commandLine?.value ?? '';
      pendingExecutions.set(event.execution, { terminal_id, command });
    });

    const endSub = onDidEndTerminalShellExecution((event) => {
      const pending = pendingExecutions.get(event.execution);
      if (pending === undefined) {
        return;
      }
      pendingExecutions.delete(event.execution);
      if (!isTerminalOwned(event.terminal)) return;

      const exit_code = event.exitCode;
      emitTerminalCommand({
        terminal_id: pending.terminal_id,
        command: pending.command,
        ...(exit_code !== undefined ? { exit_code } : {}),
      });
    });
```

Note the ownership check in `endSub` runs AFTER deleting `pendingExecutions` (to avoid a permanent leak of pending entries for unowned terminals) but BEFORE emitting — so an unowned terminal's command is silently dropped without ever leaking the pending-map entry.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test --workspace=packages/recorder -- terminal-wiring`
Expected: PASS (all existing cases + 5 new).

- [ ] **Step 5: Typecheck + lint**

Run: `npm run typecheck --workspace=packages/recorder && npm run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/recorder/src/wiring/terminal-wiring.ts packages/recorder/src/wiring/terminal-wiring.test.ts
git commit --no-gpg-sign -m "feat(recorder): route terminal events by cwd ownership"
```

---

## Task 10: Git rootUri routing

**Files:**
- Modify: `packages/recorder/src/wiring/git-wiring.ts`
- Test: `packages/recorder/src/wiring/git-wiring.test.ts`

**Interfaces:**
- Consumes: `isOwnedByThisRoot?: (fsPath: string) => boolean` field already stubbed onto `GitWiringDeps` in Task 4.
- Produces: `git.event` is only emitted when the repository's `rootUri.fsPath` is owned by this session.

**Design note:** the real `vscode.git` extension API's `Repository` interface (documented at `microsoft/vscode/extensions/git/src/api/git.d.ts`) exposes `rootUri: Uri` — the repository's root directory. This codebase deliberately avoids importing that type file and hand-rolls a minimal structural `GitRepository` type (lines 43-48) to avoid a dependency on git-extension internals; this task adds `rootUri: { fsPath: string }` to that minimal type, matching the same "duck-type just the fields we use" pattern already used for `state.HEAD` and `state.onDidChange`.

- [ ] **Step 1: Write the failing test**

Read `packages/recorder/src/wiring/git-wiring.test.ts` fully first to reuse its existing `GitAPI`/`GitRepository` mock fixtures. Append:

```ts
describe('rootUri-based ownership routing', () => {
  function makeRepo(rootFsPath: string, initialCommit?: string) {
    let changeHandler: (() => void) | undefined;
    const repo = {
      rootUri: { fsPath: rootFsPath },
      state: {
        HEAD: initialCommit !== undefined ? { commit: initialCommit } : undefined,
        onDidChange: (h: () => void) => {
          changeHandler = h;
          return { dispose() {} };
        },
      },
    };
    return { repo, fireChange: (commit?: string) => {
      if (commit !== undefined) repo.state.HEAD = { commit };
      changeHandler?.();
    } };
  }

  it('emits git.event when the repo rootUri is owned', () => {
    const emit = vi.fn();
    const { repo, fireChange } = makeRepo('/ws/cats', 'abc');
    startGitWiring({
      emit,
      getGitExtension: () =>
        ({
          exports: { getAPI: () => ({ repositories: [repo], onDidOpenRepository: () => ({ dispose() {} }) }) },
        }) as unknown as import('vscode').Extension<unknown>,
      isOwnedByThisRoot: (fsPath) => fsPath === '/ws/cats',
    });
    fireChange('def');
    expect(emit).toHaveBeenCalledOnce();
  });

  it('drops git.event when the repo rootUri is owned by no session', () => {
    const emit = vi.fn();
    const { repo, fireChange } = makeRepo('/ws/parent', 'abc');
    startGitWiring({
      emit,
      getGitExtension: () =>
        ({
          exports: { getAPI: () => ({ repositories: [repo], onDidOpenRepository: () => ({ dispose() {} }) }) },
        }) as unknown as import('vscode').Extension<unknown>,
      isOwnedByThisRoot: (fsPath) => fsPath === '/ws/cats',
    });
    fireChange('def');
    expect(emit).not.toHaveBeenCalled();
  });

  it('defaults to owning everything when isOwnedByThisRoot is omitted (regression)', () => {
    const emit = vi.fn();
    const { repo, fireChange } = makeRepo('/ws/hw03', 'abc');
    startGitWiring({
      emit,
      getGitExtension: () =>
        ({
          exports: { getAPI: () => ({ repositories: [repo], onDidOpenRepository: () => ({ dispose() {} }) }) },
        }) as unknown as import('vscode').Extension<unknown>,
    });
    fireChange('def');
    expect(emit).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace=packages/recorder -- git-wiring`
Expected: FAIL — no `rootUri`/ownership check exists yet.

- [ ] **Step 3: Implement rootUri routing**

In `packages/recorder/src/wiring/git-wiring.ts`, add `rootUri` to the minimal `GitRepository` type (lines 43-48):

```ts
type GitRepository = {
  rootUri: { fsPath: string };
  state: {
    HEAD?: { commit?: string };
    onDidChange: (handler: () => void) => vscode.Disposable;
  };
};
```

Add to `GitWiringDeps` (this field is already stubbed by Task 4 — confirm/add):

```ts
  /** Ownership filter by the repository's rootUri. Defaults to "always owned". */
  isOwnedByThisRoot?: (fsPath: string) => boolean;
```

In `startGitWiring`, destructure `isOwnedByThisRoot` (default `() => true`) and guard the emit inside `watchRepo`'s `onDidChange` handler (lines 104-128):

```ts
  const isOwnedByThisRoot = deps.isOwnedByThisRoot ?? (() => true);

  function watchRepo(repo: GitRepository): void {
    let current: string | undefined;
    try {
      current = repo.state.HEAD?.commit;
    } catch (e) {
      console.warn('[provenance] git wiring: failed to read repo HEAD:', e);
    }
    lastCommit.set(repo, current);

    let sub: vscode.Disposable;
    try {
      sub = repo.state.onDidChange(() => {
        if (!isOwnedByThisRoot(repo.rootUri.fsPath)) {
          return;
        }

        let commit_sha: string | undefined;
        try {
          commit_sha = repo.state.HEAD?.commit;
        } catch (e) {
          console.warn('[provenance] git wiring: failed to read HEAD on state change:', e);
        }

        const prev = lastCommit.get(repo);
        lastCommit.set(repo, commit_sha);

        emit({
          operation: 'state_change',
          ...(commit_sha !== undefined ? { commit_sha } : {}),
        });

        explanationTagger?.markGit();

        void prev;
      });
    } catch (e) {
      console.warn('[provenance] git wiring: failed to subscribe to repo state:', e);
      return;
    }
    disposables.push(sub);
  }
```

Note `lastCommit.set(repo, current)` still runs unconditionally at watch-start regardless of ownership (harmless bookkeeping, keeps the map consistent if ownership recalculates later); only the actual `emit(...)` + `explanationTagger?.markGit()` are gated.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test --workspace=packages/recorder -- git-wiring`
Expected: PASS (all existing cases + 3 new).

- [ ] **Step 5: Typecheck + lint**

Run: `npm run typecheck --workspace=packages/recorder && npm run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/recorder/src/wiring/git-wiring.ts packages/recorder/src/wiring/git-wiring.test.ts
git commit --no-gpg-sign -m "feat(recorder): route git events by repository rootUri ownership"
```

---

## Task 11: Seal-time QuickPick selector

**Files:**
- Create: `packages/recorder/src/commands/seal-selector.ts`
- Test: `packages/recorder/src/commands/seal-selector.test.ts`
- Modify: `packages/recorder/src/extension.ts` (`registerSealCommand`, replacing Task 5's `sessions[0]!` stub)

**Interfaces:**
- Consumes: `ActiveSession` (Task 4/5).
- Produces:
  ```ts
  export type SealQuickPickItem = { label: string; description: string; session: ActiveSession };
  export function buildSealQuickPickItems(sessions: readonly ActiveSession[]): SealQuickPickItem[];
  export async function chooseSessionForSeal(
    sessions: readonly ActiveSession[],
    showQuickPick: (items: SealQuickPickItem[], opts: { placeHolder: string }) => Promise<SealQuickPickItem | undefined>,
    activeEditorPath?: string,
  ): Promise<ActiveSession | undefined>;
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/recorder/src/commands/seal-selector.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import type { ActiveSession } from '../session/session-registry.js';
import { buildSealQuickPickItems, chooseSessionForSeal } from './seal-selector.js';

function fakeSession(root: string, assignmentId: string): ActiveSession {
  return {
    assignmentRoot: root,
    manifest: { assignment_id: assignmentId, semester: 'fa26', issued_at: '', files_under_review: [], sig: '' },
  } as unknown as ActiveSession;
}

describe('buildSealQuickPickItems', () => {
  it('labels each item by assignment_id and describes it by folder', () => {
    const items = buildSealQuickPickItems([fakeSession('/ws/cats', 'cats'), fakeSession('/ws/hog', 'hog')]);
    expect(items).toEqual([
      { label: 'cats', description: '/ws/cats', session: expect.objectContaining({ assignmentRoot: '/ws/cats' }) },
      { label: 'hog', description: '/ws/hog', session: expect.objectContaining({ assignmentRoot: '/ws/hog' }) },
    ]);
  });
});

describe('chooseSessionForSeal', () => {
  it('returns the single session directly without prompting when only one is active', async () => {
    const showQuickPick = vi.fn();
    const only = fakeSession('/ws/hw03', 'hw03');
    const chosen = await chooseSessionForSeal([only], showQuickPick);
    expect(chosen).toBe(only);
    expect(showQuickPick).not.toHaveBeenCalled();
  });

  it('returns undefined and does not prompt when there are no sessions', async () => {
    const showQuickPick = vi.fn();
    const chosen = await chooseSessionForSeal([], showQuickPick);
    expect(chosen).toBeUndefined();
    expect(showQuickPick).not.toHaveBeenCalled();
  });

  it('prompts via QuickPick when more than one session is active, returns the chosen one', async () => {
    const cats = fakeSession('/ws/cats', 'cats');
    const hog = fakeSession('/ws/hog', 'hog');
    const showQuickPick = vi.fn(async (items: { session: ActiveSession }[]) =>
      items.find((i) => i.session === hog),
    );
    const chosen = await chooseSessionForSeal([cats, hog], showQuickPick);
    expect(showQuickPick).toHaveBeenCalledOnce();
    expect(chosen).toBe(hog);
  });

  it('returns undefined when the user dismisses the QuickPick', async () => {
    const cats = fakeSession('/ws/cats', 'cats');
    const hog = fakeSession('/ws/hog', 'hog');
    const showQuickPick = vi.fn(async () => undefined);
    const chosen = await chooseSessionForSeal([cats, hog], showQuickPick);
    expect(chosen).toBeUndefined();
  });

  it('defaults the pick to the session owning the active editor when provided', async () => {
    const cats = fakeSession('/ws/cats', 'cats');
    const hog = fakeSession('/ws/hog', 'hog');
    let placeHolderSeen = '';
    const showQuickPick = vi.fn(async (items: { session: ActiveSession }[], opts: { placeHolder: string }) => {
      placeHolderSeen = opts.placeHolder;
      return items[0];
    });
    await chooseSessionForSeal([cats, hog], showQuickPick, '/ws/hog/y.py');
    // The active-editor's owning session (hog) should be sorted first so it's the default highlight.
    const itemsPassed = showQuickPick.mock.calls[0]?.[0] as { session: ActiveSession }[];
    expect(itemsPassed[0]?.session).toBe(hog);
    expect(placeHolderSeen).toContain('assignment');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace=packages/recorder -- seal-selector`
Expected: FAIL with "Cannot find module './seal-selector.js'".

- [ ] **Step 3: Implement the selector**

Create `packages/recorder/src/commands/seal-selector.ts`:

```ts
/**
 * Seal-time assignment selector (spec Design §4). When exactly one session is
 * active, sealing proceeds without a prompt (unchanged behavior). When more than
 * one is active, the student is prompted via QuickPick to choose which assignment
 * to bundle. Pure logic here; extension.ts supplies the real vscode.window.showQuickPick.
 */

import { resolveOwnerRoot } from '../session/session-router.js';
import type { ActiveSession } from '../session/session-registry.js';

export type SealQuickPickItem = {
  label: string;
  description: string;
  session: ActiveSession;
};

export function buildSealQuickPickItems(
  sessions: readonly ActiveSession[],
): SealQuickPickItem[] {
  return sessions.map((session) => ({
    label: session.manifest.assignment_id,
    description: session.assignmentRoot,
    session,
  }));
}

/**
 * Choose which session to seal.
 *
 * - No sessions: returns undefined without prompting (caller shows "no session data").
 * - Exactly one session: returns it directly, no prompt (regression-preserving).
 * - More than one: prompts via showQuickPick. If activeEditorPath resolves to one
 *   of the sessions (nearest-ancestor), that session's item is sorted first so
 *   VS Code's QuickPick highlights it as the default.
 */
export async function chooseSessionForSeal(
  sessions: readonly ActiveSession[],
  showQuickPick: (
    items: SealQuickPickItem[],
    opts: { placeHolder: string },
  ) => Promise<SealQuickPickItem | undefined>,
  activeEditorPath?: string,
): Promise<ActiveSession | undefined> {
  if (sessions.length === 0) {
    return undefined;
  }
  if (sessions.length === 1) {
    return sessions[0];
  }

  let ordered = [...sessions];
  if (activeEditorPath !== undefined) {
    const owningRoot = resolveOwnerRoot(
      activeEditorPath,
      sessions.map((s) => s.assignmentRoot),
    );
    if (owningRoot !== null) {
      ordered = [
        ...ordered.filter((s) => s.assignmentRoot === owningRoot),
        ...ordered.filter((s) => s.assignmentRoot !== owningRoot),
      ];
    }
  }

  const items = buildSealQuickPickItems(ordered);
  const chosen = await showQuickPick(items, {
    placeHolder: 'Select which assignment to prepare a submission bundle for',
  });
  return chosen?.session;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test --workspace=packages/recorder -- seal-selector`
Expected: PASS (6 tests).

- [ ] **Step 5: Wire the selector into `extension.ts`'s `registerSealCommand`**

Replace the `const chosen = sessions[0]!;` stub line from Task 5 in `packages/recorder/src/extension.ts`'s `registerSealCommand` with:

```ts
      const activeEditorPath = vscode.window.activeTextEditor?.document.uri.fsPath;
      const chosen = await chooseSessionForSeal(
        sessions,
        (items, opts) => Promise.resolve(vscode.window.showQuickPick(items, opts)),
        activeEditorPath,
      );
      if (chosen === undefined) {
        if (sessions.length > 1) {
          // User dismissed the QuickPick — no message needed, they cancelled deliberately.
          return;
        }
        void vscode.window.showWarningMessage('No session data to seal.');
        return;
      }
```

Add the import: `import { chooseSessionForSeal } from './commands/seal-selector.js';`. The rest of `registerSealCommand`'s body (the `sealBundle({...})` call and result handling) is unchanged from Task 5 except it now reads from `chosen` (already the case).

- [ ] **Step 6: Run recorder's full unit suite**

Run: `npm run test --workspace=packages/recorder`
Expected: PASS — every test file in the package, old and new.

- [ ] **Step 7: Typecheck + lint**

Run: `npm run typecheck --workspace=packages/recorder && npm run lint`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/recorder/src/commands/seal-selector.ts packages/recorder/src/commands/seal-selector.test.ts packages/recorder/src/extension.ts
git commit --no-gpg-sign -m "feat(recorder): prompt for assignment at seal time when multiple sessions are active"
```

---

## Task 12: `activationEvents` glob update (mechanical — `haiku` OK)

**Files:**
- Modify: `packages/recorder/package.json:23-26`

**Interfaces:**
- Consumes/produces: nothing code-level — this only affects when VS Code loads the extension.

- [ ] **Step 1: Update `activationEvents`**

In `packages/recorder/package.json`, change:

```json
  "activationEvents": [
    "workspaceContains:.provenance-manifest",
    "workspaceContains:provenance-manifest"
  ],
```

to:

```json
  "activationEvents": [
    "workspaceContains:**/.provenance-manifest",
    "workspaceContains:**/provenance-manifest"
  ],
```

- [ ] **Step 2: Confirm the package still builds/packages cleanly**

Run: `npm run build --workspace=packages/recorder`
Expected: no errors (this change is JSON-only and doesn't affect the TS build, but confirms nothing else broke).

- [ ] **Step 3: Commit**

```bash
git add packages/recorder/package.json
git commit --no-gpg-sign -m "chore(recorder): activate on nested .provenance-manifest files"
```

---

## Task 13: Full regression + acceptance-criteria verification pass

This task does not add new production code. It exists so a reviewer explicitly re-runs the whole spec's six acceptance-criteria groups against the finished tree and the existing real-Extension-Host smoke test, in one place, before the branch is considered done.

**Files:** none modified (verification only). If any gap surfaces, open a follow-up task rather than silently patching scope into this one.

- [ ] **Step 1: Run the full recorder unit suite**

Run: `npm run test --workspace=packages/recorder`
Expected: PASS — every `*.test.ts` file under `packages/recorder/src/`.

- [ ] **Step 2: Typecheck and lint the whole workspace**

Run: `npm run typecheck && npm run lint`
Expected: no errors (confirms nothing in `analyzer`/`server`/`shared`/`analysis-core`/`log-core` was accidentally touched or broken — this feature must not require changes outside `packages/recorder/`).

Run: `npm run build`
Expected: no errors.

- [ ] **Step 3: Cross-check each spec acceptance-criteria group against a specific test**

Confirm, and note explicitly in the PR/report if any is missing:
1. **Discovery** — `manifest-discovery.test.ts` (Task 1) + `activation.integration.test.ts`'s "multi-session discovery" describe block (Task 5).
2. **Routing** — `session-router.test.ts` (Task 2) + `doc-wiring.test.ts`'s ownership-filter cases (Task 6).
3. **Per-`.provenance/`** — `session-registry.test.ts`'s "two independent calls to startSession" case (Task 4) asserts distinct `provenanceDir` + distinct `.slog` contents per session.
4. **Seal selector** — `seal-selector.test.ts` (Task 11).
5. **Terminal/git** — `terminal-wiring.test.ts` + `git-wiring.test.ts` ownership-routing cases (Tasks 9-10).
6. **Regression (single-assignment happy path)** — `activation.integration.test.ts`'s original (untouched) describe block, still passing against `activateImpl` (Task 4), PLUS the "a manifest at the opened root still yields exactly one session" case (Task 5), PLUS the real-Extension-Host smoke test.

- [ ] **Step 4: Run the real-Extension-Host integration smoke test, if Docker/display constraints allow**

Run: `npm run test:integration --workspace=packages/recorder`
Expected: PASS (this exercises `test-workspace/`, a single manifest at the opened root — the regression case — through the real `activate()`/`deactivate()` VS Code entrypoints end to end). If the sandboxed environment cannot launch the real Extension Host (headless/display or download restrictions), report that explicitly rather than skipping silently — this is the only test that exercises the real `activate()` function (Task 5) rather than its constituent pieces.

- [ ] **Step 5: Report**

Summarize: which of the six acceptance-criteria groups are covered by which test files, full test/typecheck/lint/build output (pass/fail), and whether the integration smoke test could run in this environment. Do not mark the branch done if any of the six groups lacks a passing test — stop and report the gap instead.

---

## Self-review notes (from the plan author)

- **Spec coverage:** Design §1 (discovery) → Task 1 + Task 5's `rescan`. Design §2 (SessionRegistry) → Tasks 4-5. Design §3 (routing/scoping) → Tasks 2, 6-7. Design §4 (seal selector) → Task 11. Design §5 (terminal/git routing) → Tasks 9-10. Integrity invariants → preserved by construction in every task (no log-core/manifest-schema touch anywhere in this plan; confirmed in Task 13 Step 2 by keeping the workspace-wide typecheck/lint/build green without touching `packages/log-core`). All six acceptance-criteria groups → explicit test files named in Task 13 Step 3.
- **Ambiguities flagged and locked:** see "Plan-level decisions" section above (7 decisions). The largest is decision 4 (assignment-relative paths) — this was NOT explicit in the spec and is a genuine, necessary consequence of allowing one opened folder to contain multiple assignment roots; flag it prominently to the human reviewer as the second-highest-risk area after the Task 4 extraction itself.
- **Highest risk / highest reasoning task:** Task 4 (extracting `activateImpl`'s ~400-line body into `startSession`) — assigned `opus`. Second-highest: Task 5 (multi-session wiring in `extension.ts`, including the new `rescan` path) — kept on `sonnet` but flagged for careful review since `activate()`/`deactivate()` are the real VS Code entrypoints with no unit-test seam of their own (Task 13 Step 4's integration test is the only end-to-end check on them).
