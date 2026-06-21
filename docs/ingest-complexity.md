# Ingest pipeline time complexity

Last assessed **2026-06-20** (branch `feat/large-file-ingest`), after the
reconstruction O(n²)→O(n) fix, the shared-index / json-bulk-insert round, and
the large-file staging work.

This document records the time complexity of every ingestion stage, the
empirical evidence behind it, and where (if anywhere) further optimization is
worth doing. It is a companion to the profiling notes captured during the June
2026 perf work.

## TL;DR

- **The per-bundle pipeline is linear in event count.** The previous O(n²)
  (file-content reconstruction) is gone; an empirical sweep from 1k→100k events
  shows flat cost-per-event across every stage.
- A 100k-event bundle (a ~4-hour heavy session) costs **~1.0s of CPU**.
- The single dominant cost is **hash-chain verification** (validation Check 3):
  ~44% of CPU. It is cryptographically irreducible, runs exactly once per
  bundle, and has **no redundant double-hashing** anywhere else in the pipeline.
- **There is no remaining algorithmic win.** The pipeline is at its floor. The
  lever for fleet-scale imports (hundreds–thousands of bundles) is throughput
  (`INGEST_CONCURRENCY`), not per-bundle work.

## Notation

| symbol | meaning |
|---|---|
| **n** | events in one bundle |
| **L** | total file content size in one bundle |
| **F** | files in an upload batch |
| **S** | non-superseded submissions in a semester |
| **P** | total paste events in a semester |
| **G** | n-gram fingerprint size (bounded by the event-kind alphabet ⇒ ~constant) |

## Per-stage complexity

| # | Stage | Code | Complexity | Notes |
|---|---|---|---|---|
| — | Upload / staging | `resumable-upload.ts`, `stage-upload-job.ts` | **O(bytes)**, memory-bounded | Streamed chunks + temp file. Interleaving (commit `2f343cd`) enqueues per-file jobs as each stages — improves wall-clock, not asymptotics. |
| 2 | Dedup | `dedup.ts` | **O(log D)** | One indexed `LIMIT 1` on `(semester, blob_sha256)`. Negligible. |
| 3 | Parse bundle (`loadBundle`) | `parse-bundle-phase.ts` | **O(bytes + n)** | Unzip (inflate) + per-line `JSON.parse` + ed25519 manifest/checkpoint verify + per-submission-file sha256. Does **not** hash the chain. ~23% of CPU. |
| 4 | Match student | `match-student.ts` | **O(filename)** + 1 indexed lookup | Negligible. |
| 5 | Create submission | `create-submission.ts` | **O(versions)** + `FOR UPDATE` + S3 copy O(bytes) | A few indexed queries. Negligible. |
| — | Build index (shared, built once) | `build-index.ts` | **O(n log n)** | Flatten + chronological sort + single-pass maps. ~5% of CPU. |
| 6 | Materialize events | `materialize-events.ts` | **O(n log n)** DB, O(n) app, **1 round-trip** | Single `json_to_recordset` INSERT; cost is heap insert + index maintenance (irreducible DB floor). Not CPU-bound. |
| 7 | Compute stats | `stats.ts`, `reconstruct-file*.ts` | **O(n)** (was O(n²)) | Reconstruction uses an incremental `lineStarts` index (O(1) offset). ~3% of CPU. |
| 8 | Run validation | `run-validation.ts` | **O(n + bytes)** | 8 checks. **Dominant stage (~44%)**, but linear. Dominated entirely by Check 3 — see below. |
| 12 | Run heuristics | `run-per-submission.ts` | **O(n)** | ~19 detectors over the shared index. ~25% of CPU. |
| — | Finalize | `job-control.ts` | **O(F)** | Aggregate sibling file statuses. Negligible. |
| 14 | Cross-flags (semester) | `run-cross.ts`, `extract-cross-features-from-db.ts` | **O(Σ nₛ log nₛ) + O(S²·G) + O(P²)** | The only super-linear stage — in **S**, not n. See below. |

## The enqueue / "front half" (before any worker runs)

Everything above is per-bundle worker cost. Before the worker runs, the request
path must stage blobs, write `ingest_files` rows, and enqueue per-file jobs.
This phase is **O(F)** in the number of submission files, with **three
sequential round-trips per file** and no bulk batching:

1. `stageBlob` — one S3/MinIO `PUT` of the bundle ZIP. **O(bundle bytes)** and
   the dominant per-file cost.
2. `INSERT` one `ingest_files` row (one DB round-trip).
3. `boss.send(INGEST_FILE, …)` — one pg-boss enqueue = one `INSERT` into
   `pgboss.job` (one DB round-trip).

So the literal "queue up the jobs" cost is **F sequential `boss.send` calls**
(F single-row inserts into `pgboss.job`) — linear in F, latency-bound, and
cheap relative to staging (the S3 PUTs) and processing (~1s CPU/bundle).
Empirically the whole front half ran ~5s for a 700-small-bundle export
(~7ms/file, dominated by S3 + DB round-trip latency, not CPU). This phase is
I/O-bound and needs Postgres + MinIO to measure, so it is **not** covered by
`bench:stages`; use `profile:ingest` for it.

Where the O(F) work sits relative to the HTTP response differs by entry path:

| Entry path | Code | Enqueue location | Request latency |
|---|---|---|---|
| Multipart `POST /ingest` | `ingest.ts` ~L455 | Inline: stage all files, then a second loop of F `boss.send` | **O(F)** in-request |
| `POST /ingest:gradescope` (sync) | `local-path.ts` | Inline, **interleaved**: per file stage + insert + send, worker starts mid-stream | **O(F)** in-request |
| Resumable `POST …/complete` (large files) | `ingest.ts` ~L1123 | **Background**: request does 1 job-row insert + 1 `boss.send` (`ingest_stage_upload`), returns 202; the O(F) staging+enqueue runs in that job | **O(1)** in-request |

The resumable path — the one used for multi-GB exports — already moves the
entire O(F) front half off the request, so user-perceived latency there is O(1).

### Is the enqueue worth optimizing?

- **Multipart `POST /ingest` (the non-interleaved path) — DONE.**
  It already stages all files first and *then* enqueues, so the F `boss.send`
  calls collapsed into a single `boss.insert([…])` (pg-boss binds the whole job
  array as one JSON param — no bind-param ceiling, no chunking) and the F
  `ingest_files` inserts into a chunked bulk insert (`INGEST_FILE_INSERT_CHUNK`
  = 1000 rows/statement, to stay under Postgres's 65535-param ceiling since
  `INGEST_MAX_BATCH_FILES` is admin-raisable). Turns ~2F + 1 DB/queue round-trips
  into ~⌈F/1000⌉ + 1, with no loss of interleaving (there was none). As a bonus
  it tightened the failure semantics: rows are written only after all staging
  succeeds (a mid-staging failure now leaves zero `ingest_files` rows, not a
  partial set), and the `getBoss()`/enqueue step is now inside the compensation
  `try` so an enqueue failure marks the job `failed` instead of orphaning it as
  `queued`. The S3 PUTs (the dominant front-half cost) are unchanged, so the
  wall-clock win is modest. See `chunk.ts` and the handler in `ingest.ts`.
- **Interleaved paths (`:gradescope`, resumable) should keep per-file sends.**
  Sending each job as its bundle finishes staging lets the worker start while the
  rest of a large export is still streaming. With ~1s of processing per bundle,
  early worker start is worth far more than saving a few ms of enqueue
  round-trips. Batching here would trade that away.
- **The dominant front-half cost is the S3 PUTs (`stageBlob`), not the enqueue.**
  These are sequential and O(total bytes). Bounded-concurrency PUTs could speed a
  large export, but that competes with worker concurrency for resources and
  complicates the deliberate memory-bounded streaming on the large-file path.
  Not worth it without evidence the front half is the bottleneck (it isn't —
  per-bundle processing dominates).

## Empirical evidence

Measured with `packages/server/scripts/bench-stages.ts` (median of 3 reps, no
DB/S3 — pure CPU stages only). One faithful signed bundle is generated per size
and pushed through parse → buildIndex → computeStats → runValidation →
runHeuristics.

```
Absolute median ms per stage:
events       slogMB     parse  buildIdx     stats     valid      heur   CPU sum
10,003          3.5      25.3       3.1       5.4      51.4      22.5     107.6
25,003          8.8      59.1       8.1       8.1     116.8      53.7     245.8
50,003         17.7     113.1      24.4      14.3     220.1     116.6     488.6
100,003        35.4     229.9      47.5      31.2     441.5     247.6     997.6

Normalized ms per 10k events (flat = linear, rising = super-linear):
events        parse  buildIdx     stats     valid      heur   CPU sum
10,003        25.24      3.14      5.36     51.38     22.48    107.60
25,003        23.63      3.25      3.25     46.70     21.48     98.32
50,003        22.62      4.88      2.86     44.02     23.33     97.72
100,003       22.98      4.75      3.12     44.15     24.76     99.76
```

Every normalized column is flat. If reconstruction were still O(n²), the 100k
row's per-event cost would be ~100× the 1k row's; instead it is constant. This
is the end-to-end confirmation that the reconstruction fix holds.

### Validation is one check

Per-check breakdown (`BENCH_CHECKS=1`, 50k events):

```
1 manifest_sig=0.6  2 session_bind=0.0  3 chain=219.3  4 seq=0.1
5 monotonic_t=0.1   6 monotonic_wall=1.6  7 doc_save_hash=8.3  8 submitted_code=0.4
```

Validation's ~220ms is **entirely Check 3** (`verifyChain`). The other seven
checks are noise. Check 3 recomputes `sha256(prev_hash + JCS-canonicalize(envelope))`
for every event — the JCS canonicalization is the expensive part.

This is the tamper-evidence guarantee (recorder PRD §5.2): to detect tampering
you must recompute the chain; there is no shortcut. It is **non-negotiable** per
`CLAUDE.md` and must not be weakened.

We verified there is **no redundant hashing**: `loadBundle` reads the stored
`hash`/`prev_hash` fields without recomputing them, materialize stores them
verbatim, and cross-flags never re-hashes. The chain is recomputed exactly once
per ingest, in Check 3.

## Cross-flags: the one super-linear stage

Cross-flags is semester-scoped and the only stage that is super-linear — but in
**submission count S**, not event count n:

- **Feature extraction** (`extract-cross-features-from-db.ts`): streams one
  submission's events at a time, O(nₛ log nₛ) each, reducing to a compact
  fingerprint (pastes + bounded kind-stream n-gram set). Memory-bounded by
  design — holding full bundles for a whole semester previously OOM'd the worker.
- **`editing_pattern_clone`**: O(S²) pairwise Jaccard over the n-gram sets. Each
  comparison is O(G) with G bounded by the kind alphabet, so it is effectively
  O(S²) with a small constant.
- **`paste_shared_across_students`**: ~O(P²) worst case over pastes (sha256
  grouping is near-linear; the fuzzy fallback scans group members).

For typical cohorts this is fine. S² is the term to watch at large semester
scale, but the bounded fingerprint keeps each comparison cheap, and it runs once
per semester (debounced via pg-boss `singletonKey`), off the per-file path.

## Is there anything more to optimize?

Short answer: **not meaningfully.** The pipeline is at its algorithmic floor.

Levers considered and their verdicts:

- **Chain verification (44%, the dominant cost) — irreducible.** It is the
  tamper-evidence check; it cannot be skipped or weakened. It already runs
  exactly once with no redundancy.
  - *Theoretical lever:* Check 3 is embarrassingly parallel (each entry verifies
    against its own stored `prev_hash`, not a running value), so the per-event
    hash recompute could be sharded across `worker_threads`. This would only
    help **single-giant-bundle latency**, not throughput (throughput already
    saturates all cores via `INGEST_CONCURRENCY`). High complexity (thread pool,
    event serialization) for a narrow benefit. **Not worth it** unless one-bundle
    latency becomes a UX problem.
- **Share one reconstruction per file (the old "Lever 2") — not worth it.**
  Earlier profiling flagged reconstruction running ~8–10× per submission. Now
  that each reconstruction is O(n), the measured cost is marginal (Check 7 =
  8.3ms, Check 8 = 0.4ms, stats = 14ms at 50k). Collapsing them into one shared
  pass would save tens of ms at 50k at the cost of threading a reconstruction
  cache through the analyzer's pure-function API. **Recommend dropping it.**
- **`buildIndex` sort O(n log n) → k-way merge O(n log S) — marginal.**
  buildIndex is only ~5% of CPU; not worth the complexity.
- **Throughput for fleet-scale imports — already handled.** `INGEST_CONCURRENCY`
  processes a pg-boss batch concurrently and scales near-linearly with cores
  (700-bundle drain: 348s @ c=1 → 87s @ c=4 → 44s @ c=8). Raise it together with
  `DATABASE_POOL_MAX` (each in-flight job holds ~1 pool connection).

### Known worst case (not a regression)

Reconstruction is O(n) for append / local-edit streams — the real recorder
pattern, and what the bench measures. A pathological stream of **mid-document**
edits to one very large file is still O(L²) (each string splice copies O(L)).
This is inherent to a materialized-string reconstruction and not worth fixing
speculatively; real sessions are append-dominated.

## Running the benchmark

```bash
# Default sweep (1k, 2k, 5k, 10k, 25k, 50k, 100k events):
npm run bench:stages --workspace=packages/server

# Custom sizes:
npm run bench:stages --workspace=packages/server -- 10000 50000 100000

# With the per-validation-check breakdown:
BENCH_CHECKS=1 npm run bench:stages --workspace=packages/server -- 50000
```

No infrastructure required — it generates bundles in-process and times the pure
CPU stages. For the full route+worker path against Postgres/MinIO (DB/S3
included), use `npm run profile:large` instead.
