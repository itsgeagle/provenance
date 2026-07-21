# Internal-move paste classification

**Date:** 2026-07-21
**Status:** approved, not yet implemented
**Scope:** `packages/analysis-core` (heuristics + index), `docs/heuristics.md`

## Problem

Two ordinary student behaviours produce high-severity flags today:

1. **Copy within a file.** A student selects a block, copies it, and pastes it
   elsewhere in the same file (or into another file in the same submission —
   e.g. moving a helper into `utils.py`).
2. **Cut and paste back.** A student cuts a block and re-pastes it a few lines
   later while reorganising.

Both are indistinguishable, to the current heuristics, from pasting code in from
outside the editor. `large_paste` fires on any paste-shaped insertion ≥ 200 chars
or ≥ 10 lines. `paste_is_solution` is worse: a student who *types* the entire
solution and then reorganises it trips "pasted block has ≥ 80% line overlap with
the file's final saved state" at high severity, which reads as the single most
damning flag in the catalogue.

Flags that fire on normal work are not merely noise. They train graders to
dismiss the flag class wholesale, which costs the true positives too.

## Non-goals

- Changing `paste_matches_known_source`. An exact or fuzzy match against the
  course-staff corpus is a hard signal and does not get softened by where the
  bytes happened to be sitting a minute earlier. Left untouched, including no
  added detail field.
- Changing `SubmissionStats.pastedChars`. It keeps counting internal moves.
- Changing the cross-submission flag `paste_shared_across_students`. Excluding
  internal moves there would be actively wrong: two students whose *own typed
  code* hashes identically is a genuine collusion signal.
- Any change to the HTTP API contract or the log format.

## Approach

Classify each candidate paste as an **internal move** when its content matches a
region of the student's own prior content *whose provenance is typed*, and
downgrade — not suppress — the resulting flag.

Downgrade rather than suppress because Provenance is an evidence system. A
classifier that silently deletes findings is an unfalsifiable gate: if it is ever
wrong, nobody can tell, and there is no artifact to appeal. A downgraded flag
keeps the evidence and the audit trail while leaving the grader's ranked queue.

The provenance requirement is what makes the classifier non-gameable. Without it,
a student could paste an external solution into `scratch.py` (flagged), then cut
it and paste it into `hw3.py` — and the second paste would look internal. The
per-character provenance map (`reconstruct-file-provenance.ts`) already knows the
difference between characters that were typed and characters that arrived by
paste or external change.

## Architecture

One new module, `packages/analysis-core/src/heuristics/internal-move.ts`, plus a
context builder that reuses the existing provenance replay primitives.

```
iterateCandidatePastes(index)              ← unchanged (candidate-pastes.ts)
        ↓  collect globalIdxs of candidates clearing a size gate
buildMoveContext(index, candidateIdxs)     ← new: ONE replay pass per file
        ↓
classifyCandidate(candidate, ctx)          ← 'internal_move' | 'external' | 'unknown'
        ↓
large_paste, paste_is_solution consult the classification
```

### `buildMoveContext(index, candidateIdxs, config)`

Performs **one provenance replay pass per tracked file**, not one per paste. The
candidate `globalIdx` values are known before the pass starts, so snapshots are
captured in-stream. Reuses the exported `spliceWithProvenance`
(`index/reconstruct-file-provenance.ts:231`) rather than reimplementing splice
logic.

During the pass it records:

- **Snapshots.** At each requested `globalIdx`, the file's content plus its
  per-character provenance-kind array.

  **Size gate:** a candidate requests a snapshot only if its inserted length is
  ≥ `internalMove.minBlobChars`. Candidates below the gate are classified
  `'external'` without a snapshot — fail-closed, consistent with the rest of the
  classifier. The gate is deliberately `minBlobChars` and not
  `largePaste.minChars`: `paste_is_solution` has no size minimum of its own
  (`paste-is-solution.ts:96` accepts any non-empty content), so gating on the
  `large_paste` threshold would leave small `paste_is_solution` candidates
  unclassifiable. A paste under `minBlobChars` cannot match a ledger blob anyway,
  since blobs below that size are never recorded.

  Snapshot count is therefore bounded by the number of non-trivial pastes —
  single-digit to low-tens on a typical submission, not one per keystroke.
- **Deletion ledger.** Every removed span, as `{ text, dominantKind, globalIdx,
  path }`. This is what makes cut-then-paste detectable: at the instant of the
  paste, the text no longer exists in any file.

Cost is the same order as the `reconstructFileWithProvenance` calls
`paste_is_solution` already makes.

### Deletion ledger policy

- **Whole submission**, not time-windowed and not session-scoped. A student who
  cuts something before lunch and pastes it after is doing normal work.
- Oldest-first eviction at `ledgerMaxBytes` (default 1_000_000).
- Blobs below `minBlobChars` (default 40) are not recorded.
- No wall-clock input, so the ledger is deterministic and the classification is
  idempotent under ingest retry — which the ingest pipeline's retry tests assert.

### Matching rule

**Normalisation**, applied to both sides: split into lines, trim each line, drop
blank lines, rejoin with `\n`. This is what lets a block survive being moved into
a nested scope or auto-indented on paste.

**Match**: the normalised paste text must appear as a contiguous substring of
either

- (a) a normalised file snapshot at the candidate's `globalIdx`, across **all**
  tracked files — covering cross-file refactors; or
- (b) a normalised deletion-ledger blob — covering cut-then-paste.

Threshold: `minMatchRatio` (default 0.95) of normalised lines. Deliberately
near-exact rather than fuzzy. "80% similar to something I once wrote" is
satisfiable by a great deal of code, and a fuzzy threshold here is a hole rather
than a convenience.

**Provenance gate**: the matched source region's characters must be at least
`typedRatio` (default 0.9) of kind `'typed'`. `'preexisting'` counts as typed —
starter code the student was handed is not a paste. `'paste'` and
`'external_change'` do not count, which closes the laundering path.

### Fail closed

If reconstruction is tainted at the candidate's position, or the candidate has no
inline content (a paste over the recorder's inline cap), the classification is
`'unknown'`, and `'unknown'` is treated exactly like `'external'`: full flag, no
downgrade. The classifier can only remove noise when it is confident. Every
uncertainty leaves the flag standing.

## Flag shape after downgrade

The `heuristic` id is unchanged (`large_paste`, `paste_is_solution`), so per-flag
enable/weight toggles, the tuning UI, severity roll-ups, and cross-flag counting
keep working with no changes. What changes on a downgraded flag:

| Field | Value |
| --- | --- |
| `severity` | `'info'` |
| `title` | `Code moved within hw3.py`, or `Code moved from utils.py into hw3.py` for a cross-file move |
| `confidence` | unchanged — confidence describes paste *detection*, not the verdict |
| `detail.internalMove` | `{ sourcePath, sourceGlobalIdx, matchRatio, typedRatio, via: 'copy' \| 'cut' }` |

`via: 'cut'` when the match came from the deletion ledger, `'copy'` when it came
from a live snapshot.

Because `severity_weights.info` is 0 in the default scoring config, a downgraded
flag drops out of submission scoring automatically. No new scoring path is
needed. `detail.internalMove` is the audit trail: a grader can jump to
`sourceGlobalIdx` and see exactly where the code was before the move.

## Configuration

New block in `packages/analysis-core/src/heuristics/config.ts`:

```ts
internalMove: {
  /** false → classifier never runs; output is byte-for-byte today's behaviour. */
  enabled: true,
  /** Fraction of normalised paste lines that must match. */
  minMatchRatio: 0.95,
  /** Fraction of matched source chars that must be typed/preexisting. */
  typedRatio: 0.9,
  /** Deletion ledger cap, oldest-first eviction. */
  ledgerMaxBytes: 1_000_000,
  /** Deletions below this size are not recorded. */
  minBlobChars: 40,
}
```

No change to `packages/shared/src/api-schemas.ts`. The server-side tuning config
(`HeuristicConfigBodySchema`) carries only `per_flag {enabled, weight}` and
`severity_weights`; numeric thresholds have always lived in analysis-core
defaults. `enabled: false` is the escape hatch for a course that wants to see
every paste.

## Testing

`internal-move.test.ts`:

- copy within a single file → `internal_move`
- cut, then paste back later → `internal_move`, `via: 'cut'` (ledger path)
- cross-file move (`utils.py` → `hw3.py`) → `internal_move`
- **paste from outside, then relocate internally → stays `external`** — the
  laundering case, the most important test in the file
- block reindented on paste → still matches (normalisation)
- near-miss below `minMatchRatio` → stays `external`
- tainted reconstruction → `unknown` → stays `external`
- over-cap paste with no inline content → `unknown` → stays `external`
- ledger eviction at `ledgerMaxBytes` is oldest-first and deterministic

Regression tests in `large-paste.test.ts` and `paste-is-solution.test.ts`:
the downgrade fires with the expected title/severity/detail, and
`internalMove.enabled: false` restores current output exactly.

## Expected diff size

~250 lines of new code across 2 new files; ~30 lines of edits across
`large-paste.ts`, `paste-is-solution.ts`, `config.ts`, plus a `docs/heuristics.md`
row. This exceeds the ~200-line guidance in CLAUDE.md, but splitting it would
ship a classifier that nothing consumes.
