# Internal-Move Paste Classification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `large_paste` and `paste_is_solution` from firing at full severity when a paste is a relocation of the student's own previously-typed code; downgrade those flags to `info` with an audit trail instead.

**Architecture:** A new `internal-move.ts` classifier in `analysis-core/src/heuristics/` runs one provenance replay pass per tracked file, using a new optional observer hook on `reconstructFileWithProvenance` to capture point-in-time file snapshots. It matches each candidate paste against (a) live file content at that moment and (b) a deletion ledger built from snapshots taken at deletion sites. A match is only an internal move if the matched source region's characters were typed (or preexisting), which prevents laundering externally-pasted code by relocating it.

**Tech Stack:** TypeScript (strict), Vitest, `diff` (jsdiff). No new dependencies.

## Global Constraints

- `analysis-core` must stay **isomorphic**. No `vscode`, `node:*`, `fs`, `path`, `worker_threads`, or `crypto` imports. ESLint enforces this.
- TypeScript strict mode. No `any` except at FFI boundaries with a comment.
- Tests must be deterministic. No `Date.now()`, `Math.random()`, or wall-clock input in the classifier — ingest retries must produce identical flags.
- Flag `id` values must be deterministic: `${heuristicId}-${supportingSeqs[0]}-${indexWithinHeuristic}`.
- The `heuristic` field on a downgraded flag does **not** change. It stays `large_paste` / `paste_is_solution` so per-flag weights, severity roll-ups, and cross-flag counting keep working.
- Do not modify `packages/shared/src/api-schemas.ts`. This change requires no API contract change.
- Do not modify `paste_matches_known_source`, `SubmissionStats`, or `paste_shared_across_students`.
- Run `npm run test --workspace=packages/analysis-core` only. Do **not** run the full repo suite (testcontainers overload).
- Commit with `git commit --no-gpg-sign`, conventional-commit prefix, no `Co-Authored-By` trailer, and an **explicit pathspec** (the repo often has unrelated uncommitted work).

---

## File Structure

| File                                                                            | Responsibility                                                                                               |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `packages/analysis-core/src/index/reconstruct-file-provenance.ts` (modify)      | Gains an optional `ReplayObserver` param. Purely observational; no behaviour change when omitted.            |
| `packages/analysis-core/src/index/reconstruct-file-provenance.test.ts` (modify) | Tests for the observer firing rule.                                                                          |
| `packages/analysis-core/src/heuristics/internal-move.ts` (create)               | The classifier: normalisation, deletion-site detection, snapshot matching, ledger matching, provenance gate. |
| `packages/analysis-core/src/heuristics/internal-move.test.ts` (create)          | All classifier behaviour, including the anti-laundering case.                                                |
| `packages/analysis-core/src/heuristics/candidate-pastes.ts` (modify)            | Adds `ordinal` to `CandidatePaste` so results can be keyed stably.                                           |
| `packages/analysis-core/src/heuristics/config.ts` (modify)                      | Adds the `internalMove` config block + `mergeConfig` entry.                                                  |
| `packages/analysis-core/src/heuristics/large-paste.ts` (modify)                 | Consults the classifier; downgrades.                                                                         |
| `packages/analysis-core/src/heuristics/paste-is-solution.ts` (modify)           | Consults the classifier; downgrades.                                                                         |
| `docs/heuristics.md` (modify)                                                   | Documents the downgrade behaviour.                                                                           |

---

### Task 1: Observer hook on the provenance replay

**Files:**

- Modify: `packages/analysis-core/src/index/reconstruct-file-provenance.ts`
- Test: `packages/analysis-core/src/index/reconstruct-file-provenance.test.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: `export type ReplayObserver = { snapshotAt: number[]; onSnapshot(globalIdx: number, state: FileReplayState): void }` and a 4th parameter on `reconstructFileWithProvenance(index, filePath, upToGlobalIdx?, observer?)`.

- [ ] **Step 1: Write the failing test**

Add to `packages/analysis-core/src/index/reconstruct-file-provenance.test.ts`:

```ts
describe('reconstructFileWithProvenance — observer', () => {
  it('fires a snapshot capturing state BEFORE the event at that globalIdx', async () => {
    // Three single-char typed doc.change events appending 'a', 'b', 'c'.
    const { index } = await buildAndIndex({
      sessions: [
        {
          events: [
            { kind: 'doc.open', data: { path: '/t/f.py', content: '' } },
            {
              kind: 'doc.change',
              data: {
                path: '/t/f.py',
                source: 'typed',
                deltas: [
                  {
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                    text: 'a',
                  },
                ],
              },
            },
            {
              kind: 'doc.change',
              data: {
                path: '/t/f.py',
                source: 'typed',
                deltas: [
                  {
                    range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } },
                    text: 'b',
                  },
                ],
              },
            },
            {
              kind: 'doc.change',
              data: {
                path: '/t/f.py',
                source: 'typed',
                deltas: [
                  {
                    range: { start: { line: 0, character: 2 }, end: { line: 0, character: 2 } },
                    text: 'c',
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    const events = index.byFile.get('/t/f.py')!;
    // globalIdx of the event that inserts 'c' (the last doc.change).
    const lastChangeIdx = events[events.length - 1]!.globalIdx;

    const seen: Array<{ globalIdx: number; content: string }> = [];
    reconstructFileWithProvenance(index, '/t/f.py', undefined, {
      snapshotAt: [lastChangeIdx],
      onSnapshot: (globalIdx, state) => seen.push({ globalIdx, content: state.content }),
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.globalIdx).toBe(lastChangeIdx);
    // BEFORE the event, so 'c' has not landed yet.
    expect(seen[0]!.content).toBe('ab');
  });

  it("fires snapshots for globalIdxs past the end of this file's events", async () => {
    const { index } = await buildAndIndex({
      sessions: [
        {
          events: [{ kind: 'doc.open', data: { path: '/t/f.py', content: 'hello' } }],
        },
      ],
    });

    const seen: number[] = [];
    reconstructFileWithProvenance(index, '/t/f.py', undefined, {
      snapshotAt: [999_999],
      onSnapshot: (globalIdx, state) => {
        seen.push(globalIdx);
        expect(state.content).toBe('hello');
      },
    });

    expect(seen).toEqual([999_999]);
  });

  it('produces identical output with and without an observer', async () => {
    const { index } = await buildAndIndex({
      sessions: [
        {
          events: [
            { kind: 'doc.open', data: { path: '/t/f.py', content: 'abc\ndef\n' } },
            {
              kind: 'doc.change',
              data: {
                path: '/t/f.py',
                source: 'typed',
                deltas: [
                  {
                    range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } },
                    text: 'XYZ',
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    const withObserver = reconstructFileWithProvenance(index, '/t/f.py', undefined, {
      snapshotAt: [],
      onSnapshot: () => {},
    });
    const without = reconstructFileWithProvenance(index, '/t/f.py');

    expect(withObserver.content).toBe(without.content);
    expect(Array.from(withObserver.provenance)).toEqual(Array.from(without.provenance));
  });
});
```

If `buildAndIndex` is not already defined in this test file, add the same helper the heuristics tests use:

```ts
import { buildIndex } from './build-index.js';
import { loadBundle } from '../loader/parse-bundle.js';
import { buildTestBundle } from '../test-support/build-test-bundle.js';

async function buildAndIndex(opts: Parameters<typeof buildTestBundle>[0]) {
  const { zipBuffer } = await buildTestBundle(opts);
  const result = await loadBundle(new Blob([zipBuffer]), 'test.zip');
  if (!result.ok) throw new Error(`Bundle load failed: ${JSON.stringify(result.error)}`);
  return { index: buildIndex(result.value), bundle: result.value };
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace=packages/analysis-core -- reconstruct-file-provenance`
Expected: FAIL — `Expected 3-4 arguments, but got 4` type error, or `seen` is empty.

- [ ] **Step 3: Implement the observer**

In `reconstruct-file-provenance.ts`, add the type after the `FileReplayState` definition (around line 103):

```ts
/**
 * Optional observational hook for a replay pass.
 *
 * `snapshotAt` is a list of globalIdx values (order irrelevant — sorted
 * internally). For each value `v`, `onSnapshot(v, state)` fires exactly once,
 * with `state` reflecting every event of this file whose globalIdx is < v.
 * Values past the file's last event fire after the loop, with the final state.
 *
 * The observer never influences reconstruction. Passing one is guaranteed to
 * produce identical `content` / `provenance` output to omitting it; the only
 * difference is that the full-stream memo cache is bypassed, since a cache hit
 * would skip the loop and fire nothing.
 */
export type ReplayObserver = {
  snapshotAt: number[];
  onSnapshot(globalIdx: number, state: FileReplayState): void;
};
```

Change the signature and cache read:

```ts
export function reconstructFileWithProvenance(
  index: EventIndex,
  filePath: string,
  upToGlobalIdx?: number,
  observer?: ReplayObserver,
): FileReplayState {
  // An observer needs the loop to actually run; a memo hit would fire nothing.
  if (upToGlobalIdx === undefined && observer === undefined) {
    const cached = finalReplayCache.get(index)?.get(filePath);
    if (cached !== undefined) return cached;
  }
```

Immediately after `const blobByHash = new Map<string, string>();`, add the snapshot cursor and emitter:

```ts
// Snapshot bookkeeping. Sorted ascending; `snapCursor` is the index of the
// next pending value. Emitting materializes the current buffer, so it costs
// O(content) per fire — bounded by the caller keeping snapshotAt small.
const snapPoints = observer === undefined ? [] : [...observer.snapshotAt].sort((a, b) => a - b);
let snapCursor = 0;

function emitSnapshotsUpTo(limit: number): void {
  while (snapCursor < snapPoints.length && snapPoints[snapCursor]! <= limit) {
    const at = snapPoints[snapCursor]!;
    snapCursor++;
    observer!.onSnapshot(at, {
      content: buf.cells.join(''),
      provenance: joinProvenance(buf.provCells),
      kindByGlobalIdx,
      hashBySaveSeq,
    });
  }
}
```

Inside the event loop, as the very first statement of the `for` body (before the `upToGlobalIdx` break check):

```ts
const e = fileEvents[i]!;
if (observer !== undefined) emitSnapshotsUpTo(e.globalIdx);
if (upToGlobalIdx !== undefined && e.globalIdx >= upToGlobalIdx) break;
```

After the loop closes, before building `result`:

```ts
// Any snapshot points past this file's last event get the final state.
if (observer !== undefined) emitSnapshotsUpTo(Number.MAX_SAFE_INTEGER);
```

Change the cache write so an observed pass does not populate the memo:

```ts
  if (upToGlobalIdx === undefined && observer === undefined) {
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test --workspace=packages/analysis-core -- reconstruct-file-provenance reconstruct-line-index`
Expected: PASS, including the pre-existing fuzz lockstep test.

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add packages/analysis-core/src/index/reconstruct-file-provenance.ts \
        packages/analysis-core/src/index/reconstruct-file-provenance.test.ts
git commit --no-gpg-sign -m "feat(analysis-core): optional snapshot observer on provenance replay"
```

---

### Task 2: Config block and candidate ordinals

**Files:**

- Modify: `packages/analysis-core/src/heuristics/config.ts`
- Modify: `packages/analysis-core/src/heuristics/candidate-pastes.ts`
- Test: `packages/analysis-core/src/heuristics/config.test.ts` (create if absent)

**Interfaces:**

- Consumes: nothing from Task 1.
- Produces: `HeuristicConfig['internalMove']` with fields `{ enabled: boolean; minMatchRatio: number; typedRatio: number; ledgerMaxBytes: number; minBlobChars: number }`, and `CandidatePaste.ordinal: number` (0-based position in `iterateCandidatePastes` order).

- [ ] **Step 1: Write the failing test**

Create `packages/analysis-core/src/heuristics/config.test.ts` (or append if it exists):

```ts
import { describe, it, expect } from 'vitest';
import { DEFAULT_HEURISTIC_CONFIG, mergeConfig } from './config.js';

describe('internalMove config', () => {
  it('has the documented defaults', () => {
    expect(DEFAULT_HEURISTIC_CONFIG.internalMove).toEqual({
      enabled: true,
      minMatchRatio: 0.95,
      typedRatio: 0.9,
      ledgerMaxBytes: 1_000_000,
      minBlobChars: 40,
    });
  });

  it('merges a partial override without dropping sibling fields', () => {
    const merged = mergeConfig({ internalMove: { enabled: false } as never });
    expect(merged.internalMove.enabled).toBe(false);
    expect(merged.internalMove.minMatchRatio).toBe(0.95);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace=packages/analysis-core -- config`
Expected: FAIL — `internalMove` is undefined.

- [ ] **Step 3: Implement the config block**

In `config.ts`, add to the `HeuristicConfig` type (after the `pasteMatchesKnownSource` block, before the closing `};`):

```ts
/**
 * internal_move classification — suppresses paste flags that are really the
 * student relocating their own previously-typed code.
 */
internalMove: {
  /** false → classifier never runs; output is byte-for-byte prior behaviour. */
  enabled: boolean;
  /** Fraction of normalised paste lines that must match a source region. */
  minMatchRatio: number;
  /** Fraction of matched source chars that must be typed/preexisting. */
  typedRatio: number;
  /** Deletion ledger byte cap; oldest-first eviction. */
  ledgerMaxBytes: number;
  /** Pastes and deletions below this many chars are never classified. */
  minBlobChars: number;
}
```

Add to `DEFAULT_HEURISTIC_CONFIG` (after `interSessionExternalChange`):

```ts
  internalMove: {
    enabled: true,
    minMatchRatio: 0.95,
    typedRatio: 0.9,
    ledgerMaxBytes: 1_000_000,
    minBlobChars: 40,
  },
```

Add to `mergeConfig`'s returned object (after `interSessionExternalChange`):

```ts
    internalMove: {
      ...DEFAULT_HEURISTIC_CONFIG.internalMove,
      ...override.internalMove,
    },
```

- [ ] **Step 4: Add `ordinal` to `CandidatePaste`**

In `candidate-pastes.ts`, add to the `CandidatePaste` type (after `origin`):

```ts
/**
 * 0-based position in `iterateCandidatePastes` order. Stable across runs and
 * across consumers, because the iterator walks `index.ordered` (globalIdx
 * ascending) and yields deltas in array order. Used as the join key between
 * a candidate and its internal-move classification, which `seqKey` cannot be:
 * a multi-delta doc.change yields several candidates sharing one seqKey.
 */
ordinal: number;
```

Add a counter in `iterateCandidatePastes` — declare `let ordinal = 0;` as the first statement of the generator, then add `ordinal: ordinal++,` to **both** yielded object literals (the `paste` branch and the `doc.change` delta branch).

Also add the `globalIdx` field, needed by the classifier:

```ts
/** globalIdx of the source event. Snapshot join key for internal-move. */
globalIdx: number;
```

Set `globalIdx: e.globalIdx,` in both yield sites.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test --workspace=packages/analysis-core -- config candidate-pastes large-paste paste-is-solution paste-matches-known-source`
Expected: PASS. The three paste heuristics must be unaffected — they ignore the new fields.

- [ ] **Step 6: Typecheck, lint, commit**

Run: `npm run typecheck && npm run lint`

```bash
git add packages/analysis-core/src/heuristics/config.ts \
        packages/analysis-core/src/heuristics/config.test.ts \
        packages/analysis-core/src/heuristics/candidate-pastes.ts
git commit --no-gpg-sign -m "feat(analysis-core): internalMove config block and candidate ordinals"
```

---

### Task 3: The classifier

**Files:**

- Create: `packages/analysis-core/src/heuristics/internal-move.ts`
- Test: `packages/analysis-core/src/heuristics/internal-move.test.ts`

**Interfaces:**

- Consumes: `ReplayObserver` and the 4-arg `reconstructFileWithProvenance` (Task 1); `HeuristicConfig['internalMove']` and `CandidatePaste.ordinal` / `.globalIdx` (Task 2).
- Produces:

  ```ts
  export type MoveVia = 'copy' | 'cut';
  export type MoveClassification = 'internal_move' | 'external' | 'unknown';
  export type MoveResult = {
    classification: MoveClassification;
    sourcePath?: string;
    sourceGlobalIdx?: number;
    matchRatio?: number;
    typedRatio?: number;
    via?: MoveVia;
  };
  export function classifyInternalMoves(
    index: EventIndex,
    config: HeuristicConfig,
  ): Map<number, MoveResult>; // keyed by CandidatePaste.ordinal
  export function normalizeForMatch(text: string): string;
  ```

  A candidate absent from the returned map is `'external'` (callers use `?? { classification: 'external' }`).

- [ ] **Step 1: Write the failing tests**

Create `packages/analysis-core/src/heuristics/internal-move.test.ts`:

```ts
/**
 * Tests for the internal-move classifier.
 *
 * The load-bearing case is `does not launder an external paste`: relocating
 * code that itself arrived by paste must NOT be classified as an internal move.
 */

import { describe, it, expect } from 'vitest';
import { classifyInternalMoves, normalizeForMatch } from './internal-move.js';
import { iterateCandidatePastes } from './candidate-pastes.js';
import { buildIndex } from '../index/build-index.js';
import { loadBundle } from '../loader/parse-bundle.js';
import { buildTestBundle } from '../test-support/build-test-bundle.js';
import { DEFAULT_HEURISTIC_CONFIG, mergeConfig } from './config.js';

async function buildAndIndex(opts: Parameters<typeof buildTestBundle>[0]) {
  const { zipBuffer } = await buildTestBundle(opts);
  const result = await loadBundle(new Blob([zipBuffer]), 'test.zip');
  if (!result.ok) throw new Error(`Bundle load failed: ${JSON.stringify(result.error)}`);
  return { index: buildIndex(result.value), bundle: result.value };
}

const cfg = DEFAULT_HEURISTIC_CONFIG;

/** A 6-line, >40-char block used as the thing being moved around. */
const BLOCK = [
  'def helper(values):',
  '    total = 0',
  '    for v in values:',
  '        total += v',
  '    return total',
  '',
].join('\n');

/** Type `text` into `path` as one typed doc.change appending at the end. */
function typedAppend(path: string, text: string, line: number) {
  return {
    kind: 'doc.change' as const,
    data: {
      path,
      source: 'typed',
      deltas: [
        {
          range: { start: { line, character: 0 }, end: { line, character: 0 } },
          text,
        },
      ],
    },
  };
}

function pasteEvent(path: string, text: string, line: number) {
  return {
    kind: 'paste' as const,
    data: {
      path,
      content: text,
      length: text.length,
      range: { start: { line, character: 0 }, end: { line, character: 0 } },
    },
  };
}

/** Resolve the classification for the Nth candidate paste in the stream. */
function resultFor(index: ReturnType<typeof buildIndex>, results: Map<number, unknown>, n: number) {
  const candidates = [...iterateCandidatePastes(index)];
  const c = candidates[n];
  if (c === undefined) throw new Error(`no candidate at ordinal ${n}`);
  return results.get(c.ordinal) as
    | { classification: string; via?: string; sourcePath?: string }
    | undefined;
}

describe('normalizeForMatch', () => {
  it('strips per-line indentation and blank lines', () => {
    expect(normalizeForMatch('  a\n\n    b\n')).toBe('a\nb');
  });
});

describe('classifyInternalMoves', () => {
  it("classifies a copy of the student's own typed code as an internal move", async () => {
    const { index } = await buildAndIndex({
      sessions: [
        {
          events: [
            { kind: 'doc.open', data: { path: '/t/hw.py', content: '' } },
            typedAppend('/t/hw.py', BLOCK, 0),
            { kind: 'doc.save', data: { path: '/t/hw.py', sha256: 'x'.repeat(64) } },
            pasteEvent('/t/hw.py', BLOCK, 6),
          ],
        },
      ],
    });

    const results = classifyInternalMoves(index, cfg);
    const r = resultFor(index, results, 0);
    expect(r?.classification).toBe('internal_move');
    expect(r?.via).toBe('copy');
    expect(r?.sourcePath).toBe('/t/hw.py');
  });

  it('classifies cut-then-paste-back as an internal move via the ledger', async () => {
    const { index } = await buildAndIndex({
      sessions: [
        {
          events: [
            { kind: 'doc.open', data: { path: '/t/hw.py', content: '' } },
            typedAppend('/t/hw.py', BLOCK, 0),
            // Cut: replace lines 0..5 with nothing.
            {
              kind: 'doc.change',
              data: {
                path: '/t/hw.py',
                source: 'typed',
                deltas: [
                  {
                    range: { start: { line: 0, character: 0 }, end: { line: 5, character: 0 } },
                    text: '',
                  },
                ],
              },
            },
            pasteEvent('/t/hw.py', BLOCK, 0),
          ],
        },
      ],
    });

    const results = classifyInternalMoves(index, cfg);
    const r = resultFor(index, results, 0);
    expect(r?.classification).toBe('internal_move');
    expect(r?.via).toBe('cut');
  });

  it('classifies a cross-file move as an internal move', async () => {
    const { index } = await buildAndIndex({
      sessions: [
        {
          events: [
            { kind: 'doc.open', data: { path: '/t/utils.py', content: '' } },
            typedAppend('/t/utils.py', BLOCK, 0),
            { kind: 'doc.open', data: { path: '/t/hw.py', content: '' } },
            pasteEvent('/t/hw.py', BLOCK, 0),
          ],
        },
      ],
    });

    const results = classifyInternalMoves(index, cfg);
    const r = resultFor(index, results, 0);
    expect(r?.classification).toBe('internal_move');
    expect(r?.sourcePath).toBe('/t/utils.py');
  });

  it('does NOT launder an external paste that is later relocated', async () => {
    const { index } = await buildAndIndex({
      sessions: [
        {
          events: [
            { kind: 'doc.open', data: { path: '/t/scratch.py', content: '' } },
            // Arrives by paste — provenance kind 'paste', not 'typed'.
            pasteEvent('/t/scratch.py', BLOCK, 0),
            { kind: 'doc.open', data: { path: '/t/hw.py', content: '' } },
            // Relocated into the graded file.
            pasteEvent('/t/hw.py', BLOCK, 0),
          ],
        },
      ],
    });

    const results = classifyInternalMoves(index, cfg);
    // Candidate 0 is the original external paste.
    expect(resultFor(index, results, 0)?.classification).not.toBe('internal_move');
    // Candidate 1 is the relocation — the whole point: it stays flagged.
    expect(resultFor(index, results, 1)?.classification).not.toBe('internal_move');
  });

  it('matches a block that was reindented on paste', async () => {
    const reindented = BLOCK.split('\n')
      .map((l) => (l.length > 0 ? `    ${l}` : l))
      .join('\n');
    const { index } = await buildAndIndex({
      sessions: [
        {
          events: [
            { kind: 'doc.open', data: { path: '/t/hw.py', content: '' } },
            typedAppend('/t/hw.py', BLOCK, 0),
            pasteEvent('/t/hw.py', reindented, 6),
          ],
        },
      ],
    });

    const results = classifyInternalMoves(index, cfg);
    expect(resultFor(index, results, 0)?.classification).toBe('internal_move');
  });

  it('leaves a near-miss below minMatchRatio as external', async () => {
    const altered = BLOCK.replace('total += v', 'total -= v * 2 + 17');
    const { index } = await buildAndIndex({
      sessions: [
        {
          events: [
            { kind: 'doc.open', data: { path: '/t/hw.py', content: '' } },
            typedAppend('/t/hw.py', BLOCK, 0),
            pasteEvent('/t/hw.py', altered, 6),
          ],
        },
      ],
    });

    const results = classifyInternalMoves(index, cfg);
    expect(resultFor(index, results, 0)?.classification).not.toBe('internal_move');
  });

  it('leaves a paste below minBlobChars as external', async () => {
    const tiny = 'x = 1\n';
    const { index } = await buildAndIndex({
      sessions: [
        {
          events: [
            { kind: 'doc.open', data: { path: '/t/hw.py', content: '' } },
            typedAppend('/t/hw.py', tiny, 0),
            pasteEvent('/t/hw.py', tiny, 1),
          ],
        },
      ],
    });

    const results = classifyInternalMoves(index, cfg);
    expect(resultFor(index, results, 0)?.classification).not.toBe('internal_move');
  });

  it('returns an empty map when disabled', async () => {
    const { index } = await buildAndIndex({
      sessions: [
        {
          events: [
            { kind: 'doc.open', data: { path: '/t/hw.py', content: '' } },
            typedAppend('/t/hw.py', BLOCK, 0),
            pasteEvent('/t/hw.py', BLOCK, 6),
          ],
        },
      ],
    });

    const disabled = mergeConfig({ internalMove: { ...cfg.internalMove, enabled: false } });
    expect(classifyInternalMoves(index, disabled).size).toBe(0);
  });

  it('treats preexisting starter code as typed', async () => {
    const { index } = await buildAndIndex({
      sessions: [
        {
          events: [
            // Starter code handed to the student — provenance kind 'preexisting'.
            { kind: 'doc.open', data: { path: '/t/hw.py', content: BLOCK } },
            pasteEvent('/t/hw.py', BLOCK, 6),
          ],
        },
      ],
    });

    const results = classifyInternalMoves(index, cfg);
    expect(resultFor(index, results, 0)?.classification).toBe('internal_move');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test --workspace=packages/analysis-core -- internal-move`
Expected: FAIL — `Cannot find module './internal-move.js'`.

- [ ] **Step 3: Implement the classifier**

Create `packages/analysis-core/src/heuristics/internal-move.ts`:

```ts
/**
 * internal_move classification.
 *
 * A paste is an "internal move" when its content matches a region of the
 * student's own prior content whose provenance is typed (or preexisting starter
 * code). Those pastes are the student reorganising their own work — copying a
 * block, or cutting and re-pasting it — and firing large_paste /
 * paste_is_solution at full severity on them trains graders to dismiss the whole
 * flag class.
 *
 * The provenance requirement is what stops this being a laundering path. Without
 * it, a student could paste an external solution into scratch.py, then cut it and
 * paste it into hw3.py, and the second paste would look internal.
 *
 * Everything here is fail-closed: any uncertainty (tainted reconstruction, a
 * paste with no inline content, a candidate below the size gate) yields
 * 'external' or 'unknown', both of which leave the flag standing.
 */

import type { EventIndex } from '../index/event-index.js';
import type { ProvenanceKind, FileReplayState } from '../index/reconstruct-file-provenance.js';
import { reconstructFileWithProvenance } from '../index/reconstruct-file-provenance.js';
import type { HeuristicConfig } from './config.js';
import { iterateCandidatePastes } from './candidate-pastes.js';
import type { CandidatePaste } from './candidate-pastes.js';

export type MoveVia = 'copy' | 'cut';
export type MoveClassification = 'internal_move' | 'external' | 'unknown';

export type MoveResult = {
  classification: MoveClassification;
  sourcePath?: string;
  sourceGlobalIdx?: number;
  matchRatio?: number;
  typedRatio?: number;
  via?: MoveVia;
};

/** Provenance kinds that count as "the student's own work". */
const OWN_KINDS: ReadonlySet<ProvenanceKind> = new Set<ProvenanceKind>(['typed', 'preexisting']);

/**
 * Normalise text for structural comparison: drop per-line indentation and blank
 * lines, normalise line endings. This is what lets a block survive being moved
 * into a nested scope or auto-indented by the editor on paste.
 */
export function normalizeForMatch(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join('\n');
}

/** One entry in the deletion ledger. */
type LedgerEntry = {
  globalIdx: number;
  path: string;
  text: string;
  /** True when the removed region was predominantly the student's own work. */
  own: boolean;
};

/** A deletion site to snapshot: (globalIdx, path, flat range to extract). */
type DeletionSite = {
  globalIdx: number;
  path: string;
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
};

/**
 * Flat offset of a (line, character) position in `content`, clamped the same way
 * the replay clamps. Kept local so the classifier never depends on replay
 * internals.
 */
function offsetOf(content: string, line: number, character: number): number {
  if (line < 0) return 0;
  let offset = 0;
  let currentLine = 0;
  while (currentLine < line) {
    const nl = content.indexOf('\n', offset);
    if (nl === -1) return content.length;
    offset = nl + 1;
    currentLine++;
  }
  const nl = content.indexOf('\n', offset);
  const lineEnd = nl === -1 ? content.length : nl;
  return Math.min(offset + character, lineEnd);
}

/**
 * Fraction of `[start, end)` in `state` attributable to the student's own work.
 * Returns 0 for an empty span.
 */
function ownRatio(state: FileReplayState, start: number, end: number): number {
  if (end <= start) return 0;
  let own = 0;
  for (let i = start; i < end && i < state.provenance.length; i++) {
    const kind = state.kindByGlobalIdx.get(state.provenance[i]!);
    if (kind !== undefined && OWN_KINDS.has(kind)) own++;
  }
  return own / (end - start);
}

/**
 * Pre-filter deletion sites from event payloads, without needing content: any
 * delta over a range spanning >= 2 lines, or >= minBlobChars on one line. Exact
 * byte length is measured later against the snapshot.
 */
function collectDeletionSites(index: EventIndex, minBlobChars: number): DeletionSite[] {
  const sites: DeletionSite[] = [];
  for (const e of index.ordered) {
    if (e.kind !== 'doc.change' && e.kind !== 'paste') continue;
    const p = e.payload as Record<string, unknown> | null;
    if (p === null) continue;
    const path = typeof p['path'] === 'string' ? p['path'] : undefined;
    if (path === undefined) continue;

    const ranges: DeletionSite['range'][] = [];
    if (e.kind === 'paste') {
      const r = p['range'] as DeletionSite['range'] | undefined;
      if (r !== undefined) ranges.push(r);
    } else {
      const deltas = p['deltas'];
      if (!Array.isArray(deltas)) continue;
      for (const dRaw of deltas as unknown[]) {
        if (typeof dRaw !== 'object' || dRaw === null) continue;
        const d = dRaw as { range?: DeletionSite['range'] };
        if (d.range !== undefined) ranges.push(d.range);
      }
    }

    for (const range of ranges) {
      const lineSpan = range.end.line - range.start.line;
      const charSpan = range.end.character - range.start.character;
      if (lineSpan >= 2 || (lineSpan === 0 && charSpan >= minBlobChars) || lineSpan === 1) {
        sites.push({ globalIdx: e.globalIdx, path, range });
      }
    }
  }
  return sites;
}

/**
 * Does `needle` (normalised) appear in `haystack` (normalised)? Returns the flat
 * offset in the NORMALISED haystack, or -1.
 *
 * minMatchRatio < 1 permits a prefix match: we accept when the first
 * ceil(ratio * lines) normalised lines of the needle appear contiguously. This
 * is deliberately near-exact — fuzzy matching here would be a hole, since "80%
 * similar to something I once wrote" is satisfiable by a great deal of code.
 */
function findNormalized(haystack: string, needle: string, minMatchRatio: number): number {
  if (needle.length === 0) return -1;
  const direct = haystack.indexOf(needle);
  if (direct !== -1) return direct;
  if (minMatchRatio >= 1) return -1;
  const lines = needle.split('\n');
  const keep = Math.ceil(lines.length * minMatchRatio);
  if (keep <= 0 || keep >= lines.length) return -1;
  return haystack.indexOf(lines.slice(0, keep).join('\n'));
}

/**
 * Map a match offset in normalised space back to an approximate span in the
 * ORIGINAL content, for the provenance check. Normalisation only removes
 * whitespace and blank lines, so a line-count walk is exact at line granularity.
 */
function originalSpanForNormalizedMatch(
  original: string,
  normalizedOffset: number,
  normalizedLength: number,
): { start: number; end: number } {
  const normalizedPrefixLines =
    normalizedOffset === 0 ? 0 : normalizedOffset === -1 ? 0 : countLines(normalizedOffset);
  function countLines(upTo: number): number {
    let n = 0;
    for (let i = 0; i < upTo; i++) if (original.charCodeAt(i) === 10) n++;
    return n;
  }
  // Walk the original, skipping blank lines, until we have passed
  // `normalizedPrefixLines` non-blank lines; that is the span start.
  const originalLines = original.split('\n');
  let nonBlankSeen = 0;
  let start = 0;
  let idx = 0;
  for (; idx < originalLines.length; idx++) {
    const line = originalLines[idx]!;
    if (line.trim().length > 0) {
      if (nonBlankSeen === normalizedPrefixLines) break;
      nonBlankSeen++;
    }
    start += line.length + 1;
  }
  const wantLines = normalizedLength === 0 ? 0 : normalizedLength.valueOf();
  let end = start;
  let counted = 0;
  for (; idx < originalLines.length && counted < wantLines; idx++) {
    const line = originalLines[idx]!;
    end += line.length + 1;
    if (line.trim().length > 0) counted++;
  }
  return { start, end: Math.min(end, original.length) };
}

export function classifyInternalMoves(
  index: EventIndex,
  config: HeuristicConfig,
): Map<number, MoveResult> {
  const results = new Map<number, MoveResult>();
  const cfg = config.internalMove;
  if (!cfg.enabled) return results;

  // Candidates that clear the size gate. Below it, we never classify — a paste
  // under minBlobChars cannot match a ledger blob anyway.
  const candidates: CandidatePaste[] = [];
  for (const c of iterateCandidatePastes(index)) {
    if (c.content === undefined) continue; // over-cap paste → 'unknown' → stays flagged
    if (c.content.length < cfg.minBlobChars) continue;
    candidates.push(c);
  }
  if (candidates.length === 0) return results;

  const normalizedByOrdinal = new Map<number, string>();
  for (const c of candidates) {
    normalizedByOrdinal.set(c.ordinal, normalizeForMatch(c.content!));
  }

  const deletionSites = collectDeletionSites(index, cfg.minBlobChars);
  const sitesByIdx = new Map<number, DeletionSite[]>();
  for (const s of deletionSites) {
    const arr = sitesByIdx.get(s.globalIdx);
    if (arr === undefined) sitesByIdx.set(s.globalIdx, [s]);
    else arr.push(s);
  }

  const snapshotAt = [
    ...new Set([...candidates.map((c) => c.globalIdx), ...deletionSites.map((s) => s.globalIdx)]),
  ].sort((a, b) => a - b);

  const ledger: LedgerEntry[] = [];
  let ledgerBytes = 0;

  // --- Phase 1: one replay pass per file. ---------------------------------
  for (const path of index.byFile.keys()) {
    reconstructFileWithProvenance(index, path, undefined, {
      snapshotAt,
      onSnapshot: (globalIdx, state) => {
        // (a) Live-content match for any candidate at this globalIdx.
        for (const c of candidates) {
          if (c.globalIdx !== globalIdx) continue;
          if (results.get(c.ordinal)?.classification === 'internal_move') continue;
          // A paste cannot be sourced from the region it is overwriting in its
          // own file at its own instant; that is the same bytes, not a move.
          const needle = normalizedByOrdinal.get(c.ordinal)!;
          const haystack = normalizeForMatch(state.content);
          const at = findNormalized(haystack, needle, cfg.minMatchRatio);
          if (at === -1) continue;
          const span = originalSpanForNormalizedMatch(state.content, at, needle.split('\n').length);
          const typed = ownRatio(state, span.start, span.end);
          if (typed < cfg.typedRatio) continue;
          results.set(c.ordinal, {
            classification: 'internal_move',
            sourcePath: path,
            sourceGlobalIdx: globalIdx,
            matchRatio: 1,
            typedRatio: typed,
            via: 'copy',
          });
        }

        // (b) Deletion ledger: extract removed text from the pre-event state.
        for (const site of sitesByIdx.get(globalIdx) ?? []) {
          if (site.path !== path) continue;
          const start = offsetOf(state.content, site.range.start.line, site.range.start.character);
          const end = offsetOf(state.content, site.range.end.line, site.range.end.character);
          if (end - start < cfg.minBlobChars) continue;
          const text = state.content.slice(start, end);
          if (ledgerBytes + text.length > cfg.ledgerMaxBytes) {
            // Oldest-first eviction, deterministic.
            while (ledger.length > 0 && ledgerBytes + text.length > cfg.ledgerMaxBytes) {
              ledgerBytes -= ledger[0]!.text.length;
              ledger.shift();
            }
          }
          ledger.push({
            globalIdx,
            path,
            text,
            own: ownRatio(state, start, end) >= cfg.typedRatio,
          });
          ledgerBytes += text.length;
        }
      },
    });
  }

  // --- Phase 2: ledger match, no replay state needed. ---------------------
  for (const c of candidates) {
    if (results.get(c.ordinal)?.classification === 'internal_move') continue;
    const needle = normalizedByOrdinal.get(c.ordinal)!;
    for (const entry of ledger) {
      if (entry.globalIdx >= c.globalIdx) continue;
      if (!entry.own) continue;
      if (findNormalized(normalizeForMatch(entry.text), needle, cfg.minMatchRatio) === -1) continue;
      results.set(c.ordinal, {
        classification: 'internal_move',
        sourcePath: entry.path,
        sourceGlobalIdx: entry.globalIdx,
        matchRatio: 1,
        typedRatio: 1,
        via: 'cut',
      });
      break;
    }
  }

  return results;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test --workspace=packages/analysis-core -- internal-move`
Expected: PASS, all cases.

If `originalSpanForNormalizedMatch` misbehaves on the reindent case, debug it against the `matches a block that was reindented on paste` test specifically — do **not** relax `minMatchRatio` or `typedRatio` to make a test pass. Those thresholds are the security property; loosening them is a product decision, not a coding one.

- [ ] **Step 5: Typecheck, lint, commit**

Run: `npm run typecheck && npm run lint`

```bash
git add packages/analysis-core/src/heuristics/internal-move.ts \
        packages/analysis-core/src/heuristics/internal-move.test.ts
git commit --no-gpg-sign -m "feat(analysis-core): internal-move paste classifier"
```

---

### Task 4: Wire the downgrade into large_paste

**Files:**

- Modify: `packages/analysis-core/src/heuristics/large-paste.ts`
- Test: `packages/analysis-core/src/heuristics/large-paste.test.ts`

**Interfaces:**

- Consumes: `classifyInternalMoves(index, config): Map<number, MoveResult>` (Task 3), `CandidatePaste.ordinal` (Task 2).
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

Append to `packages/analysis-core/src/heuristics/large-paste.test.ts`:

```ts
describe('large_paste — internal move downgrade', () => {
  const BLOCK = [
    'def helper(values):',
    '    total = 0',
    '    for v in values:',
    '        total += v',
    '    return total',
    '    # padding to clear the 200 char threshold ------------------------',
    '    # padding to clear the 200 char threshold ------------------------',
    '    # padding to clear the 200 char threshold ------------------------',
    '',
  ].join('\n');

  it("downgrades a relocation of the student's own typed code to info", async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            { kind: 'doc.open', data: { path: '/t/hw.py', content: '' } },
            {
              kind: 'doc.change',
              data: {
                path: '/t/hw.py',
                source: 'typed',
                deltas: [
                  {
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                    text: BLOCK,
                  },
                ],
              },
            },
            {
              kind: 'paste',
              data: {
                path: '/t/hw.py',
                content: BLOCK,
                length: BLOCK.length,
                range: {
                  start: { line: 9, character: 0 },
                  end: { line: 9, character: 0 },
                },
              },
            },
          ],
        },
      ],
    });

    const flags = largePasteHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe('info');
    expect(flags[0]!.title).toContain('Code moved');
    expect(flags[0]!.heuristic).toBe('large_paste');
    const detail = flags[0]!.detail as { internalMove?: { via?: string } };
    expect(detail.internalMove?.via).toBe('copy');
  });

  it('keeps full severity when internalMove is disabled', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            { kind: 'doc.open', data: { path: '/t/hw.py', content: '' } },
            {
              kind: 'doc.change',
              data: {
                path: '/t/hw.py',
                source: 'typed',
                deltas: [
                  {
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                    text: BLOCK,
                  },
                ],
              },
            },
            {
              kind: 'paste',
              data: {
                path: '/t/hw.py',
                content: BLOCK,
                length: BLOCK.length,
                range: {
                  start: { line: 9, character: 0 },
                  end: { line: 9, character: 0 },
                },
              },
            },
          ],
        },
      ],
    });

    const disabled = mergeConfig({ internalMove: { ...cfg.internalMove, enabled: false } });
    const flags = largePasteHeuristic.run(index, bundle, disabled);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).not.toBe('info');
    expect(flags[0]!.title).toContain('Large paste');
  });
});
```

Add `mergeConfig` to the existing import from `./config.js` at the top of the file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test --workspace=packages/analysis-core -- large-paste`
Expected: FAIL — severity is `'high'`, not `'info'`.

- [ ] **Step 3: Implement the downgrade**

In `large-paste.ts`, add the import:

```ts
import { classifyInternalMoves } from './internal-move.js';
```

In `run()`, after `const anomalyWindows = buildAnomalyWindows(index);`:

```ts
const moves = classifyInternalMoves(index, config);
```

Replace the flag-construction block (from `const severity: Severity =` through the `flags.push({...})` call) with:

```ts
// Severity: escalate if either high-severity threshold is met.
const baseSeverity: Severity =
  length >= highSeverityChars || lines >= highSeverityLines ? 'high' : 'medium';

// Confidence: reduced if inside a paste.anomaly window.
const anomalyTs = anomalyWindows.get(c.sessionId);
const confidence = isInAnomalyWindow(c.t, anomalyTs) ? ANOMALY_CONFIDENCE : NORMAL_CONFIDENCE;

const id = flagId(c.seqKey, flagIndex++);

const lineInfo = lines > 0 ? `, ${lines} lines` : '';
const sourceDescriptor =
  c.origin === 'paste' ? 'A paste' : 'A paste-shaped bulk edit (doc.change/paste_likely)';

// An internal move is the student relocating their own previously-typed
// code. Keep the record (evidence is never destroyed) but drop it to info,
// which scores 0 under the default severity weights and leaves the ranked
// queue. `heuristic` is deliberately unchanged so per-flag weights and
// severity roll-ups keep working.
const move = moves.get(c.ordinal);
const isMove = move?.classification === 'internal_move';

const severity: Severity = isMove ? 'info' : baseSeverity;
const title = isMove
  ? move!.sourcePath !== undefined && move!.sourcePath !== c.path
    ? `Code moved from ${move!.sourcePath} into ${c.path}`
    : `Code moved within ${c.path}`
  : `Large paste in ${c.path}`;
const description = isMove
  ? `${length} characters${lineInfo} were relocated into ${c.path} from the student's own ` +
    `previously-typed code in ${move!.sourcePath}. Not treated as an external paste.`
  : `${sourceDescriptor} of ${length} characters${lineInfo} was detected in ${c.path}.`;

flags.push({
  id,
  heuristic: 'large_paste',
  title,
  severity,
  confidence,
  supportingSeqs: [c.seqKey],
  description,
  detail: {
    path: c.path,
    charCount: length,
    lineCount: lines > 0 ? lines : null,
    inAnomalyWindow: isInAnomalyWindow(c.t, anomalyTs),
    origin: c.origin,
    ...(isMove
      ? {
          internalMove: {
            sourcePath: move!.sourcePath,
            sourceGlobalIdx: move!.sourceGlobalIdx,
            matchRatio: move!.matchRatio,
            typedRatio: move!.typedRatio,
            via: move!.via,
          },
        }
      : {}),
  },
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test --workspace=packages/analysis-core -- large-paste`
Expected: PASS — including every pre-existing large_paste test, which must be unaffected (none of them contain a prior typed copy of the pasted text).

- [ ] **Step 5: Typecheck, lint, commit**

Run: `npm run typecheck && npm run lint`

```bash
git add packages/analysis-core/src/heuristics/large-paste.ts \
        packages/analysis-core/src/heuristics/large-paste.test.ts
git commit --no-gpg-sign -m "feat(analysis-core): downgrade large_paste on internal moves"
```

---

### Task 5: Wire the downgrade into paste_is_solution

**Files:**

- Modify: `packages/analysis-core/src/heuristics/paste-is-solution.ts`
- Test: `packages/analysis-core/src/heuristics/paste-is-solution.test.ts`

**Interfaces:**

- Consumes: `classifyInternalMoves` (Task 3), `CandidatePaste.ordinal` (Task 2).
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

Append to `packages/analysis-core/src/heuristics/paste-is-solution.test.ts`:

```ts
describe('paste_is_solution — internal move downgrade', () => {
  const SOLUTION = [
    'def solve(data):',
    '    result = []',
    '    for row in data:',
    '        result.append(row * 2)',
    '    return result',
    '',
  ].join('\n');

  it('downgrades to info when the student typed the solution then moved it', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            { kind: 'doc.open', data: { path: '/t/hw.py', content: '' } },
            {
              kind: 'doc.change',
              data: {
                path: '/t/hw.py',
                source: 'typed',
                deltas: [
                  {
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                    text: SOLUTION,
                  },
                ],
              },
            },
            // Cut the whole thing out...
            {
              kind: 'doc.change',
              data: {
                path: '/t/hw.py',
                source: 'typed',
                deltas: [
                  {
                    range: { start: { line: 0, character: 0 }, end: { line: 5, character: 0 } },
                    text: '',
                  },
                ],
              },
            },
            // ...and paste it back.
            {
              kind: 'paste',
              data: {
                path: '/t/hw.py',
                content: SOLUTION,
                length: SOLUTION.length,
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              },
            },
          ],
        },
      ],
    });

    const flags = pasteIsSolutionHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe('info');
    expect(flags[0]!.heuristic).toBe('paste_is_solution');
    const detail = flags[0]!.detail as { internalMove?: { via?: string } };
    expect(detail.internalMove?.via).toBe('cut');
  });
});
```

Ensure `mergeConfig` is imported if not already.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace=packages/analysis-core -- paste-is-solution`
Expected: FAIL — severity is `'high'`.

- [ ] **Step 3: Implement the downgrade**

In `paste-is-solution.ts`, add the import:

```ts
import { classifyInternalMoves } from './internal-move.js';
```

In `run()`, after `const threshold = config.pasteIsSolution.lineOverlap;`:

```ts
const moves = classifyInternalMoves(index, config);
```

Replace the `flags.push({...})` call with:

```ts
const move = moves.get(c.ordinal);
const isMove = move?.classification === 'internal_move';

flags.push({
  id,
  heuristic: 'paste_is_solution',
  title: isMove
    ? move!.sourcePath !== undefined && move!.sourcePath !== c.path
      ? `Code moved from ${move!.sourcePath} into ${c.path}`
      : `Code moved within ${c.path}`
    : `Paste matches solution in ${c.path}`,
  severity: isMove ? 'info' : 'high',
  confidence: 0.85,
  supportingSeqs: [c.seqKey],
  description: isMove
    ? `An insertion in ${c.path} shares ${Math.round(ratio * 100)}% of its lines with the ` +
      `file's final content, but it is a relocation of the student's own previously-typed ` +
      `code in ${move!.sourcePath}. Not treated as an external paste.`
    : `${sourceDescriptor} in ${c.path} shares ${Math.round(ratio * 100)}% of its lines with the ` +
      `file's final content, suggesting the insertion may be the complete solution.`,
  detail: {
    filePath: c.path,
    pasteLines,
    sharedLines: shared,
    overlapRatio: ratio,
    threshold,
    origin: c.origin,
    ...(isMove
      ? {
          internalMove: {
            sourcePath: move!.sourcePath,
            sourceGlobalIdx: move!.sourceGlobalIdx,
            matchRatio: move!.matchRatio,
            typedRatio: move!.typedRatio,
            via: move!.via,
          },
        }
      : {}),
  },
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test --workspace=packages/analysis-core -- paste-is-solution run-heuristics`
Expected: PASS, including the orchestrator suite.

- [ ] **Step 5: Typecheck, lint, commit**

Run: `npm run typecheck && npm run lint`

```bash
git add packages/analysis-core/src/heuristics/paste-is-solution.ts \
        packages/analysis-core/src/heuristics/paste-is-solution.test.ts
git commit --no-gpg-sign -m "feat(analysis-core): downgrade paste_is_solution on internal moves"
```

---

### Task 6: Full analysis-core suite and documentation

**Files:**

- Modify: `docs/heuristics.md`

**Interfaces:**

- Consumes: everything from Tasks 1–5.
- Produces: nothing.

- [ ] **Step 1: Run the whole analysis-core suite**

Run: `npm run test --workspace=packages/analysis-core`
Expected: PASS. Investigate any pre-existing test that changed behaviour — a paste heuristic test that now yields `info` means that fixture contains a genuine internal move, which is worth confirming case by case rather than assuming.

Do **not** run the repo-wide `npm run test`.

- [ ] **Step 2: Document the behaviour**

In `docs/heuristics.md`, add after the "Shared iterator" paragraph:

```markdown
**Internal-move downgrade.** `large_paste` and `paste_is_solution` consult
[`internal-move.ts`](../packages/analysis-core/src/heuristics/internal-move.ts)
before emitting. When a paste's content matches a region of the student's own
prior content whose provenance is _typed_ (or preexisting starter code), the flag
is retitled "Code moved within/from …", dropped to `info` severity — scoring 0
under the default severity weights — and carries a `detail.internalMove`
block naming the source path and event. The flag is never suppressed: the record
and its audit trail remain.

The provenance requirement is load-bearing. Relocating code that itself arrived
by paste or external change does **not** qualify, so a paste cannot be laundered
by moving it between files. Matching is near-exact (`minMatchRatio: 0.95`) after
per-line indentation is stripped, so reindent-on-paste still matches while
"vaguely similar" does not. Cut-then-paste is covered by a deletion ledger built
during the same replay pass. Set `internalMove.enabled: false` to restore the
prior behaviour exactly.
```

- [ ] **Step 3: Commit**

```bash
git add docs/heuristics.md
git commit --no-gpg-sign -m "docs(heuristics): document the internal-move downgrade"
```

---

## Self-Review Notes

**Spec coverage.** Every spec section maps to a task: observer hook → Task 1; config + ordinals → Task 2; matching rule, normalisation, provenance gate, ledger policy, fail-closed → Task 3; flag shape for both heuristics → Tasks 4–5; docs → Task 6. Non-goals (`paste_matches_known_source`, `SubmissionStats`, cross-flags, `api-schemas.ts`) are named in Global Constraints as do-not-touch.

**Known risk, flagged for the implementer.** `originalSpanForNormalizedMatch` maps a normalised-space match back to original-space offsets so the provenance check can run. This is the fiddliest function in the change and the most likely source of an off-by-one on the reindent and blank-line cases. If it resists, the correct fallback is to compute the provenance ratio over the _whole_ matched file region rather than the exact span — more conservative, never less. Relaxing `typedRatio` or `minMatchRatio` is not an acceptable fix.
