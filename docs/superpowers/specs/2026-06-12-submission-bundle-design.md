# Submission Bundle: carry final files + verify submitted code

**Date:** 2026-06-12
**Status:** Approved design, pre-implementation
**Affects:** `log-core`, `recorder`, `analyzer`, `server`, `shared`

## Problem

Today a sealed `.provenance` bundle contains only the provenance record — `.slog`
logs, `.slog.meta`, `manifest.json`, `manifest.sig`. It carries **zero student
code**. Two consequences:

1. The bundle is not the source of truth for what the student actually submitted.
   The only copy of the code lives implicitly inside `doc.change` events.
2. The validator's Check 8 `submitted_code_match` has always been **skipped**
   (`analyzer-progress.md:1010`), documented as "requires course-staff final-file
   hashes; not provided." There is nothing to compare the recording against.

Additionally, `sealBundle` **aborts** with `chain_broken` when the hash chain
doesn't validate (`recorder/src/commands/seal.ts`). A student whose log was
tampered with (or corrupted) cannot produce a bundle at all — which means tamper
evidence never reaches the analyzer.

## Goals

1. The bundle becomes the single source of truth for **both** provenance **and**
   the student's submission. It carries the final on-disk bytes of every file in
   the `.cs61a` manifest's `files_under_review`.
2. Sealing **always produces a bundle**, regardless of chain breakage, tampering,
   or corruption. Integrity problems are detected at **analysis time**, not by
   refusing to seal.
3. The analyzer wires up the dormant Check 8 `submitted_code_match`: reconstruct
   each reviewed file from its event stream and compare to the submitted bytes.
   A mismatch on an intact chain is a hard integrity failure.
4. Course staff can **view the submitted source** in the analyzer — both the
   in-browser `/local` route and the server-backed drill-in.

## Non-goals

- No change to the hash-chain format or event schemas.
- No diff UI between submitted and reconstructed source (possible later; the
  Source view shows submitted bytes + a per-file match status).
- No persistence of student source outside the existing bundle blob (see Retention).

## Approach (chosen: A)

**A — submission files at the zip root + a signed `submission_files[]` array in the
manifest.** The existing manifest signature covers the new field, binding the
submission to the same session key as the provenance. One signature, one source of
truth. `format_version` bumps `1.0 → 1.1` (additive, approved).

Rejected: **B** (separate `submission-manifest.json` + second signature — more
moving parts, two things that can disagree); **C** (hashes only, no bytes — bundle
stops being the submission source of truth, and a file edited entirely outside the
recording has no ground-truth bytes to compare against).

## Bundle layout

Submission files live at the **zip root**, mirroring the real workspace layout
(the workspace root is exactly "a folder with a `.provenance/` dir inside it"):

```
[assignment]-bundle-[timestamp].zip
├── .provenance/
│   ├── session-*.slog
│   ├── session-*.slog.meta
│   ├── manifest.json          # format_version now "1.1"
│   └── manifest.sig           # signature now also covers submission_files
├── hw03.py                    # final on-disk bytes of a reviewed file
└── lab02/q1.py                # workspace-relative path preserved
```

The analyzer identifies submission files via the manifest's
`submission_files[].path` list — **not** "every zip entry outside `.provenance/`" —
so stray/unexpected files cannot be treated as submission content. Only files in
`files_under_review` are ever bundled.

## Manifest change — `packages/log-core/src/bundle.ts`

`format_version: '1.0' → '1.1'`. New field:

```ts
submission_files: ReadonlyArray<{
  path: string;                       // workspace-relative; matches a files_under_review entry
  status: 'present' | 'missing';
  sha256: string | null;              // sha256 of raw on-disk bytes; null iff status === 'missing'
}>;
```

- The hash is over the **raw on-disk bytes at seal time** — that is the submission.
- The signature is computed over the canonicalized manifest exactly as today
  (JCS / RFC 8785), so it now binds the submission hashes too.
- **Backward compatibility:** the analyzer accepts both `1.0` (no
  `submission_files`; Check 8 stays skipped, as today) and `1.1` (Check 8 runs).
  Test vectors for the 1.1 manifest are added in `bundle`'s tests.

This is a format-contract change (CLAUDE.md): explicitly approved, version-bumped,
both ends updated in the same change set.

## Recorder seal changes — `packages/recorder/src/commands/seal.ts`

1. **Bundle the reviewed files.** After building session entries, for each entry in
   `files_under_review`: if present on disk → read raw bytes, hash them, add the
   bytes to the zip at the workspace-relative path, emit a `present` manifest entry;
   if absent → emit a `missing` entry (`sha256: null`), no bytes.
2. **Never abort on a broken chain.** Remove the `chain_broken` early return.
   `sealBundle` now always proceeds and hashes the `.slog` bytes **as they are**
   (tampered or not). The `SealResult.ok` variant gains a `warnings` field
   (e.g. `{ chainBroken: boolean }`) so the command surfaces a **non-blocking**
   notice to the student ("Bundle produced. Integrity issues were detected and will
   be reviewed."). `no_sessions` and `write_error` remain hard aborts (nothing to
   seal / nowhere to write).
3. **Corruption edge case.** If a `.slog` is so corrupt its `session.start` can't be
   parsed, still include the raw file + its hash in `sessions[]` with
   `session_id: null`; the analyzer flags the orphan. Keeps "always go through."

## Analyzer changes

### Ingest — `packages/analyzer/src/loader/parse-bundle.ts` + server ingest
- Accept `format_version` `1.1`; parse `submission_files`.
- Read the submission file bytes from the zip root by `submission_files[].path`.
- Bundle self-check: each bundled file's bytes must hash to its manifest `sha256`
  (detects a malformed/edited bundle).

### Check 8 — `validation/run-validation.ts` + new `validation/verify-submitted-code.ts`
For each reviewed file, reconstruct final content from its event stream and compare
to the submitted bytes:

| Case | Verdict |
|------|---------|
| Submitted bytes match reconstruction | **pass** |
| Mismatch, chain intact (edited outside the recording) | **fail** + high-severity `submitted_code_match` flag |
| No usable events / reconstruction tainted / chain broken | **skip** (Check 3 already fails this) |
| `status: 'missing'` | **skip** for that file (nothing to compare) |

The `submitted_code_match` flag joins `KNOWN_HEURISTIC_IDS` (`v3-progress.md:236`)
so tuning/recompute handle it. It is integrity-derived → no thresholds. It flows
through the existing integrity-flag adapter alongside `chain_broken`.

### Submitted-source view (local + server)
A "Source" tab in the submission drill-in lists each reviewed file with its content
and its Check-8 status (matched / mismatch / missing). Both paths go through the
existing `SubmissionDataProvider` abstraction:
- **`/local`:** `InMemorySubmissionDataProvider` reads the submission files straight
  from the in-browser zip.
- **Server-backed:** a server-backed provider calls a new endpoint (below).

### Server — submitted-source endpoint
- New endpoint (e.g. `GET /api/v1/submissions/:id/files` to list,
  `GET /api/v1/submissions/:id/files/{path}` for content), auth-guarded like the
  other submission endpoints. Response shape added to `packages/shared`.
- Contents are served by **extracting them on demand from the already-stored bundle
  blob** in object storage — student source is **not** copied into Postgres.

#### Retention (CLAUDE.md-sensitive)
The retention sweep deletes blobs but keeps DB rows forever for audit. Persisting
submitted source in Postgres would make student code outlive the sweep, defeating
it. Therefore source is read on demand from the blob, and the Source view is
unavailable once a submission's blob has been retention-swept (consistent with the
bundle itself being gone). No "purge rows" path is added.

### Extension-hash allowlist
`seal.ts` changes alter the recorder's `dist/`, so the VSIX `extension_hash`
changes. Rebuild the recorder and run `npm run update-hashes` to refresh
`packages/analyzer/src/heuristics/config/known-good-extension-hashes.json`,
otherwise every new bundle trips `extension_hash_mismatch`.

## Testing

- **`log-core`:** manifest 1.1 round-trip; canonicalize → sign → verify including
  `submission_files`; 1.0 vectors still pass.
- **`recorder`:** seal bundles present files at the zip root; marks missing ones;
  **produces a bundle on a broken chain** (regression for goal #2) and surfaces the
  warning; corrupt-`session.start` orphan handling.
- **`analyzer`:** Check 8 pass / fail-on-mismatch / skip-on-broken-chain / skip-on-
  missing; ingest of a 1.1 bundle; back-compat ingest of a 1.0 bundle; Source view
  renders files + statuses through both providers.
- **`server`:** the files endpoint extracts from the stored blob, is auth-guarded,
  and 404s gracefully when the blob is gone.

## Open risks

- Reconstruction fidelity: Check 8 depends on the event-stream reconstruction
  matching what was actually on disk. Legitimate save-time transforms (e.g. an
  autoformatter run outside the recorder) would surface as a `fail`. Accepted —
  staff review the flag; the chosen "hard fail" strictness was the explicit
  product decision.
- Bundle size grows by the size of the reviewed files (text; negligible for CS 61A).
