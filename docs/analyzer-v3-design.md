# Analyzer v3 Design — Cohort Review, API-First

**Status:** Design draft (pre-technical-PRD)
**Audience:** Engineering (Aaryan + Claude), course staff stakeholders for review
**Supersedes:** PRD §7.1 ("future v3 might add a server-side bulk-review mode for staff. That's a separate design."). This document _is_ that separate design.
**Companion:** PRD `docs/prd.md` (product behavior, log format, heuristics catalog), `CLAUDE.md` (code conventions).
**Working title:** Provenance Analyzer v3 — "Cohort."

---

## 1. Why this document exists

The v2 analyzer is a static SPA that opens one bundle at a time. Course staff scale needs the opposite: an instructor inspecting academic-integrity signals across **all submissions for all students in a semester, in one interface**, ranked, filterable, and tunable. The PI was explicit: "these will be analyzed in batches, so don't build 'drag the student file here' into the analysis interface … design it so that an instructor can inspect academic violations on all projects for all students in one interface." A separate, earlier piece of feedback was equally directive: **"build an API to query the process log efficiently, then build the viz tools on top of that."**

Together those two pieces of feedback force a structural change in the analyzer, not a feature addition. v3 is therefore:

- A **server-backed cohort tool** that becomes the analyzer's primary surface.
- An **API-first** product. The cohort UI is the first client of a documented query API over the process log; future tools (LLM v3 review, course-staff Python/R scripts, third-party dashboards) are first-class additional clients.
- A **multi-tenant identity model** (Course → Semester → Membership) backed by a real database.
- A **batch ingest** pipeline: roster CSV + bulk-upload of bundles, idempotent on bundle hash, with an unmatched tray for filename mismatches.
- A **tunable scoring layer** that lets course staff weight heuristics per semester and recompute.

The existing v2 SPA is preserved in two roles: (a) its overview / replay / timeline / validation / export modules are _reused_ inside the cohort app as the per-submission drill-in, now reading from the API instead of an in-memory bundle; (b) the standalone single-bundle "drop a `.zip` and look at it" experience is retained as a sibling route at `/local`, no auth, no DB — an escape hatch for ad-hoc off-cohort review.

This document does not specify implementation. It specifies the design we will hand off to the technical PRD (next step), which will then drive an implementation plan (the step after that).

---

## 2. Brainstorming outcome — locked decisions

These were confirmed in the brainstorm before this doc was written. They are not up for relitigation here; revisions go through the Decision Log (§16).

1. **Hosting.** One Berkeley-hosted shared instance. Single deployment, single DB, single object-storage bucket. Not SaaS multi-tenant, not self-hosted per course.
2. **Entity model.** Course (long-lived) → Semester → Assignment → Submission. Access grants are (User × Semester × Role). Superadmin tier sits above and creates Courses & Semesters.
3. **Roles.** Superadmin (global) | course-staff admin per semester (can delegate within their semester) | TA/grader per semester (view + review only).
4. **Auth.** Google OAuth only, restricted to `berkeley.edu` Google Workspace accounts (the bConnected tenant). No CalNet/SAML, no GitHub, no magic links. Per-user API tokens for non-UI clients.
5. **Bundle → student mapping.** Per-semester roster CSV + per-semester filename convention (regex with named groups; `sid` required, `assignment_id` falls back to the bundle's signed manifest). Mismatches go to an unmatched tray for manual reconciliation.
6. **Score model.** Per-submission `score = Σ(severity_weight × confidence × per_flag_weight)`. Per-flag weights are tunable per semester. Student-level aggregate defaults to `sum`, with `max` as a UI alternate sort. Score is a sort key, never a verdict.
7. **API surface.** Documented public REST + JSON API with OpenAPI spec, per-user tokens, versioned routes (`/api/v1/...`), rate-limited. The cohort UI is the first client.
8. **Persistence.** Original `.zip` in object storage as tamper-evidence source-of-truth. Events materialized into a Postgres `events` table at ingest. Derived flag / stat / score / validation rows live alongside it. Replay/timeline/overview all read from the DB; only re-validation of the hash chain rereads the blob.
9. **v2 SPA fate.** Existing per-submission modules (overview / replay / timeline / validation / export) are reused inside the cohort app, with their data sources swapped from in-memory bundle to API. The standalone drop-a-zip SPA stays as a sibling route at `/local`.

---

## 3. Approaches considered (and rejected)

Three architectures were viable; one was picked. Documenting all three so future contributors can see why.

### 3.1 Picked: "Server + materialized events + thin API + reused viz modules"

- Postgres holds events + derived rows.
- Object storage holds raw bundles.
- A typed HTTP API exposes everything the cohort UI and future tools need.
- The frontend is a single React app with two modes: cohort (auth-gated, reads API) and local (no auth, reads in-browser).
- Heuristic recompute is a background job triggered on config change or new ingest.

**Why picked.** Direct match to both pieces of PI feedback (cohort-first, API-first). Reuses 800+ tests of v2 viz code as-is on the per-submission drill-in. Postgres is boring and we already have the data shapes from v2's `EventIndex`. The cost — running a real server with backups and SSO — is unavoidable given the feedback.

### 3.2 Rejected: "Server holds blobs only; lazy in-memory per-submission index"

- Object storage holds blobs.
- The server doesn't materialize events. On first per-submission API request it parses the blob into v2's `EventIndex` and caches it (Redis or on-disk JSON).
- Cohort queries fan out to N submissions' caches.

**Why rejected.** The documented API has to answer cross-submission queries like _"give me every `fs.external_change` event with `new_content_size > 4 KB` across fa26-hw03"_ — that's the kind of question a course-staff script will reasonably ask. With this model that's a fan-out over hundreds of submissions on cold cache, and the SQL would have to be implemented as application code over cached JSON. The pricing is wrong: ingest is rare (once per submission), queries are frequent, so paying once at ingest is correct.

### 3.3 Rejected: "Replace v2 viz entirely; rebuild inside cohort app"

- Cohort app owns its own per-submission UI built from scratch.
- v2 SPA is killed.

**Why rejected.** The v2 modules — Monaco replay with gutter/hover, virtualized timeline, validation report panel, markdown/PDF export — are extensively tested, work today, and the data shapes line up cleanly with what the API can return. Rebuilding them buys design freedom we don't need at the cost of months of regressions.

---

## 4. Architecture overview

```
                      ┌─────────────────────────────────────┐
                      │   Cohort UI (React, auth-gated)     │
                      │   - Cohort list / filters / sort    │
                      │   - Ingest + roster mgmt            │
                      │   - Heuristic tuning                │
                      │   - Per-submission drill-in         │
                      │     (reuses v2 overview/replay/etc) │
                      └──────────────┬──────────────────────┘
                                     │ HTTPS / cookie auth
                                     │
   ┌─────────────────────────────────┼──────────────────────────────────┐
   │                                 │                                  │
   │   Standalone SPA  (/local)      │   Course staff scripts /         │
   │   - No auth, no DB              │   third-party tools              │
   │   - Drop-a-zip viewer           │   - Bearer-token auth            │
   │   - In-browser only             │   - Same OpenAPI                 │
   └─────────────────────────────────┴──────────────────────────────────┘
                                     │
                                     ▼
                      ┌─────────────────────────────────────┐
                      │   Public REST API   (/api/v1)       │
                      │   - OpenAPI 3.1 spec                │
                      │   - Cookie auth (UI) + Bearer (CLI) │
                      │   - Rate-limited per principal      │
                      └──────┬──────────────────────────────┘
                             │
        ┌────────────────────┼────────────────────┐
        ▼                    ▼                    ▼
  ┌───────────┐       ┌──────────────┐     ┌──────────────────┐
  │ Postgres  │       │ Object Store │     │  Worker pool     │
  │  - events │       │  - .zip      │     │  - ingest        │
  │  - flags  │       │    bundles   │     │  - recompute     │
  │  - score  │       │    (immut.)  │     │  - cross-flags   │
  │  - roster │       └──────────────┘     │  - exports       │
  │  - users  │                            └──────────────────┘
  │  - audit  │
  └───────────┘
```

The system's only mutable source of truth for derived data is Postgres. Blobs are immutable post-ingest. Workers read blobs at ingest, write derived rows; thereafter the API serves derived rows directly. Re-validation of the hash chain (a manual rare action, e.g. during an integrity hearing) is the only path that rereads the blob.

---

## 5. API resource model

The API is the contract. Visualizations are clients. Schema definitions are deferred to the technical PRD; this section enumerates the resources and their relationships.

### 5.1 Versioning & auth

- All routes are namespaced under `/api/v1`. Breaking changes move to `/api/v2` with a deprecation window.
- Two auth modes share a single principal model:
  - **Cookie session** (UI): set by the Google OAuth login flow. Short-lived access token + rotating refresh. The OAuth callback verifies the returned ID token's `hd` claim equals `berkeley.edu` _and_ the `email_verified` claim is true; anything else is rejected at the callback with a clear error.
  - **Bearer token** (scripts): per-user API tokens with optional scope reduction (read-only, semester-scoped, time-boxed). Tokens are issued only to users who have completed a successful Google login at least once.
- Every endpoint resolves to a principal, then to an authorization decision against (principal, target semester, role).
- Rate limits are applied per (principal, route-class). Cohort-list reads get a higher ceiling than ingest.

### 5.2 Resources

The mental model is RESTful with one deliberate exception (the events query, which is a filter endpoint, not a sub-resource list). Resources:

**Identity & structure**

- `GET    /api/v1/me` — current principal, memberships, superadmin bit.
- `GET    /api/v1/courses`, `POST` — superadmin-only writes.
- `GET    /api/v1/courses/{courseId}`, `PATCH`, `DELETE` (archive only).
- `GET    /api/v1/courses/{courseId}/semesters`, `POST`.
- `GET    /api/v1/semesters/{semesterId}`, `PATCH`.
- `GET    /api/v1/semesters/{semesterId}/members`, `POST`, `DELETE`. Course-staff admin can write within the semester they admin; superadmin always.

**Roster**

- `GET    /api/v1/semesters/{semesterId}/roster` — paginated roster.
- `POST   /api/v1/semesters/{semesterId}/roster:upload` — multipart CSV upload. Diff vs current shown before commit.
- `GET    /api/v1/semesters/{semesterId}/roster/{studentId}` — student detail (incl. all submissions in semester).

**Assignments**

- `GET    /api/v1/semesters/{semesterId}/assignments` — auto-discovered list. Each entry tracks `assignment_id_str` (from bundles), submission count, distinct-student count, mean/median score.
- `PATCH  /api/v1/semesters/{semesterId}/assignments/{assignmentId}` — staff-friendly label, sort order.

**Ingest**

- `POST   /api/v1/semesters/{semesterId}/ingest` — start an ingest job (multi-file or zip-of-zips upload). Returns `job_id`.
- `GET    /api/v1/semesters/{semesterId}/ingest/jobs/{jobId}` — status (`queued`, `running`, `partial`, `succeeded`, `failed`), per-file summaries.
- `GET    /api/v1/semesters/{semesterId}/unmatched` — paginated unmatched-bundle tray.
- `PATCH  /api/v1/semesters/{semesterId}/unmatched/{ingestFileId}` — manually attach to a student/assignment, or discard.

**Cohort**

- `GET    /api/v1/semesters/{semesterId}/submissions` — the central cohort list. Filterable by `assignment_id`, `student_id`, `flag_id`, `validation_status`, `score_min`, `score_max`, `kind` (any submission whose events include kind X), `has_external_edits`, `has_paste_above`, free-text on student display name. Sortable by `score`, `student`, `assignment`, `ingested_at`. Paginated, cursor-based. Default page size 50, max 500.
- `GET    /api/v1/semesters/{semesterId}/students` — student-level rollup. Aggregates `score_sum` and `score_max` over the student's submissions; flag-count breakdown by severity. Same filters where they make sense.

**Per-submission (the v2 viz layer reads these)**

- `GET    /api/v1/submissions/{submissionId}` — summary (assignment, student, ingested_at, recorder_version, format_version, validation_status, score_total, blob hash, flag counts).
- `GET    /api/v1/submissions/{submissionId}/events` — **the process-log query endpoint.** Filters: `kind` (multi), `seq_from`, `seq_to`, `t_from`, `t_to`, `wall_from`, `wall_to`, `file`, `session_id`. Sorts: `seq` asc default. Paginated. This is the endpoint a course-staff script would hammer; designed to be cheap (covered indexes, no joins).
- `GET    /api/v1/submissions/{submissionId}/events/{seq}` — single event by global seq within the submission.
- `GET    /api/v1/submissions/{submissionId}/flags` — per-submission flags.
- `GET    /api/v1/submissions/{submissionId}/stats` — per-file stats.
- `GET    /api/v1/submissions/{submissionId}/validation` — validation report (the 8-check PRD §5.4 result).
- `GET    /api/v1/submissions/{submissionId}/files` — list of files under review for this submission.
- `GET    /api/v1/submissions/{submissionId}/files/{path}/content?at_seq=N` — reconstructed file content at a given event seq (default: at last save). Backs the Monaco replay. Implementation note: the v2 `reconstructFileWithProvenance` runs server-side on demand; result is cached per (submission, path, at_seq) for the session's lifetime.
- `GET    /api/v1/submissions/{submissionId}/files/{path}/provenance?at_seq=N` — provenance (typed/paste/external/preexisting) per character, for gutter rendering.
- `GET    /api/v1/submissions/{submissionId}/bundle` — download original `.zip`. Access logged in audit table.

**Cross-submission**

- `GET    /api/v1/semesters/{semesterId}/cross-flags` — cross-bundle flags (`paste_shared_across_students`, `editing_pattern_clone`). Filterable by participants, kind, score.
- `GET    /api/v1/cross-flags/{crossFlagId}` — detail incl. all participating submissions.

**Heuristic config & recompute**

- `GET    /api/v1/semesters/{semesterId}/heuristic-config` — current per-flag weights + thresholds + on/off bits + the active config's version number.
- `PUT    /api/v1/semesters/{semesterId}/heuristic-config` — new version. Body returns a _preview diff_ (which submissions move which way) before commit when called with `?dryRun=true`.
- `POST   /api/v1/semesters/{semesterId}/recompute` — enqueue a recompute job. Returns `job_id`.
- `GET    /api/v1/semesters/{semesterId}/recompute/{jobId}` — recompute status.

**Findings export** (reuses v2 markdown/PDF exporters server-side)

- `POST   /api/v1/submissions/{submissionId}/export` — body picks format (`markdown` / `pdf`), returns a one-shot signed download URL. The export job runs synchronously for small bundles, asynchronously for large.

**User tokens**

- `GET    /api/v1/me/tokens`, `POST`, `DELETE` — per-user API token CRUD.

**Audit (admin)**

- `GET    /api/v1/audit?semester_id=…&actor=…&since=…` — append-only audit log. Superadmin sees all; semester admin sees their own semester.

### 5.3 What the API deliberately does _not_ expose

- No bulk write endpoints (other than ingest and roster upload). All other writes are per-resource.
- No "raw row" endpoint that bypasses the resource model.
- No live-stream / websocket in v3.0; long-running jobs are polled via the `jobs` endpoints. Server-Sent Events upgrade is a v3.1 candidate.
- No student-identity-revealing endpoint is callable from a token scoped read-only-flags-only.

---

## 6. Persistence layer

### 6.1 Object storage

- One bucket, structured `s3://<bucket>/semesters/{semesterId}/submissions/{submissionId}/bundle.zip`.
- Bundles are immutable; no overwrites. Versioning is at the submission level (see §6.2 `submissions.version_index`).
- Lifecycle policy ties to `semester.blob_retention_days` (defaults TBD; expected ~18 mo from semester end).
- Server-side encryption (SSE) on by default; key management TBD with Berkeley IT.

### 6.2 Postgres schema sketch

This is a _shape sketch_ for design review; the technical PRD will pin every column type, constraint, and index.

```
courses (id, name, slug, created_at, archived_at)
semesters (id, course_id, term, year, slug, blob_retention_days, created_at, archived_at)
users (id, email, google_subject, display_name, is_superadmin, created_at, last_login_at)
  -- google_subject is the immutable `sub` claim from Google's ID token; auth keys off this,
  -- not email, because Workspace users can have their primary email changed by admins.
memberships (user_id, semester_id, role, granted_by_user_id, granted_at)
  PK (user_id, semester_id)
  role ∈ {'admin', 'grader'}

roster_entries (id, semester_id, sid, display_name, email, extras_jsonb)
  UNIQUE (semester_id, sid)
assignments (id, semester_id, assignment_id_str, label, sort_order, created_at)
  UNIQUE (semester_id, assignment_id_str)
ingest_jobs (id, semester_id, uploaded_by_user_id, status, summary_jsonb, created_at, completed_at)
ingest_files (id, ingest_job_id, original_filename, blob_sha256, status, matched_student_id, matched_assignment_id, submission_id, error_jsonb)
  INDEX (ingest_job_id), INDEX (blob_sha256)
  status ∈ {'pending','matched','unmatched','duplicate','failed','superseded'}

submissions (id, semester_id, assignment_id, student_id, blob_object_key, blob_sha256, recorder_version, format_version, ingest_job_id, ingested_at, version_index, superseded_by_submission_id, score_total, score_max_flag_severity, validation_status, heuristic_config_version)
  UNIQUE (semester_id, assignment_id, student_id, version_index)
  INDEX (semester_id, assignment_id, score_total DESC)
  INDEX (semester_id, student_id)
  INDEX (blob_sha256)

events (submission_id, seq, t, wall, kind, payload_jsonb, prev_hash, hash)
  PK (submission_id, seq)
  INDEX (submission_id, kind, t)
  INDEX (submission_id, t)
  -- Partition strategy: range-partition by semester_id (joined via submissions) is overkill at 61A scale;
  -- start with a single table + the indexes above. Reassess if any one semester exceeds ~50M rows.

per_file_stats (submission_id, file_path, chars_typed, chars_pasted, chars_external_change_delta, saves, final_length, start_length, reconstruction_tainted)
  PK (submission_id, file_path)

flags (id, submission_id, heuristic_id, severity, confidence, weight_at_compute, score_contribution, detail_jsonb, supporting_seqs_int[], session_id, created_at, heuristic_config_version)
  INDEX (submission_id), INDEX (semester_id_via_submission, heuristic_id)  -- via materialized helper
  -- semester_id is denormalized onto flags for the cohort filter; keep it consistent via trigger or app-level write path

validation_results (submission_id, check_1_ok, check_2_ok, check_3_ok, check_4_ok, check_5_ok, check_6_ok, check_7_ok, check_8_ok, overall_status, detail_jsonb, validated_at)
  PK (submission_id)

cross_flags (id, semester_id, heuristic_id, severity, confidence, detail_jsonb, participants_jsonb, created_at, heuristic_config_version)
cross_flag_participants (cross_flag_id, submission_id, supporting_seqs_int[])
  PK (cross_flag_id, submission_id)

heuristic_configs (id, semester_id, config_jsonb, version, set_by_user_id, set_at, note)
  UNIQUE (semester_id, version)
recompute_jobs (id, semester_id, target_config_id, status, progress_total, progress_done, created_at, completed_at, summary_jsonb)

api_tokens (id, user_id, label, prefix, hashed_token, scopes_jsonb, last_used_at, expires_at, revoked_at, created_at)
  INDEX (prefix)

audit_log (id, actor_user_id, semester_id, action, target_type, target_id, detail_jsonb, ip, user_agent, at)
  INDEX (semester_id, at), INDEX (actor_user_id, at)
```

Design notes:

- `flags.semester_id` is denormalized for cohort filters; integrity maintained at write time (submissions never change semester). A trigger could enforce it; app-level enforcement is fine if the write path is centralized in one service module.
- `submissions.heuristic_config_version` lets the cohort view show "this submission was scored under config v7" — important during a recompute, when some rows are stale and others are fresh.
- Events live in a single wide table. At CS 61A scale (~thousands of submissions × tens of thousands of events ≈ low millions per semester) Postgres on modern hardware will not blink. If a future high-volume semester pushes this past ~50M rows we revisit partitioning.
- `cross_flag_participants` is a junction table so cohort queries can find "all cross-flags involving submission X" without a JSONB scan.

### 6.3 File reconstruction cache

The Monaco replay needs `content` and `provenance` at every scrub position. Computing them from events every time is wasteful but precomputing every (submission, file, seq) triple is also wasteful. Design choice: **server computes and caches `(submission, file, at_seq)` results in-process with an LRU**, keyed by submission. Cold-load latency for a session = one pass over events for that file. Subsequent scrubbing within the same submission hits the cache. Cache eviction is per-process; no Redis dependency in v3.0. If memory pressure becomes a problem, demote to disk-backed cache.

The v2 `reconstructFileWithProvenance` function is ported as-is into the server (it's pure TypeScript with no DOM dependencies — already lives in `packages/analyzer/src/index/`). No reimplementation.

---

## 7. Ingest pipeline

### 7.1 Inputs

- A semester admin (or delegate) initiates ingest via the UI or `POST /ingest`.
- Input is one of: (a) a single zip-of-zips containing many `.zip` bundles, (b) a multi-file upload of individual bundles. Both routes converge on the same job model.
- The semester's roster must exist; uploads against a semester with no roster fail with a clear error.

### 7.2 Phases (per file)

1. **Receive & store blob.** Stream upload to object storage. Compute `blob_sha256` as we stream.
2. **Dedup.** If a submission with this `blob_sha256` already exists in this semester, mark `ingest_files.status = 'duplicate'`, link to existing submission, skip the rest of the pipeline. Re-uploading the same artifact is idempotent.
3. **Parse manifest + sessions.** Reuse `packages/log-core`'s parser to read `manifest.json`, validate session signatures, walk events. Failure here marks the file `failed` with the error in `error_jsonb`; the bundle blob is retained for forensics.
4. **Match student.** Apply the semester's filename convention regex to `original_filename`. Extract `sid` and (if present) `assignment_id_str`.
   - If `sid` resolves to a roster entry: matched.
   - If `assignment_id_str` is absent from the filename, fall back to the bundle's signed `.cs61a` manifest's `assignment_id`.
   - If `sid` is absent or unknown: status `unmatched`. Sits in the tray awaiting manual reconciliation.
5. **Create submission row.** Allocate `version_index` = `max(existing for (semester, assignment, student)) + 1`. Existing submissions with lower indexes are flagged `superseded_by_submission_id` pointing at the new row, but kept for history.
6. **Materialize events.** Insert event rows. For a typical submission this is hundreds-to-tens-of-thousands of rows; batched with `COPY` or a multi-row `INSERT`.
7. **Compute per-file stats.** Run v2's `computeStats` server-side. Insert `per_file_stats`.
8. **Run validation.** v2's `runValidation` produces the 8-check `validation_results`.
9. **Run heuristics.** v2's `runHeuristics` (the full PRD §7.4 suite) under the semester's current `heuristic_configs.version`. Each flag's `weight_at_compute` is recorded so a later config change can re-rank without losing the historical view.
10. **Compute submission `score_total`.** Sum of `score_contribution` over flags. Update `submissions`.
11. **Emit per-file status events** on the job so the UI's progress bar can advance.

Cross-submission heuristics do not run per-file. They are enqueued once per ingest job, after all files in the job have finished phase 10, against the full semester membership.

### 7.3 Failure handling

- A file that fails any of phases 3–10 leaves the blob in place and an `ingest_files.status = 'failed'` row with a structured error. The job continues with the rest of its files; the job's overall status becomes `partial` if any file fails.
- The unmatched tray supports retry (re-apply the regex after a roster correction), manual attach (admin picks student + assignment), and discard (mark for deletion at retention sweep).

### 7.4 Idempotency

- `(semester, blob_sha256)` is the natural idempotency key. Re-uploading the same bytes never creates a second submission.
- A file matched to (assignment, student) that was previously matched to a _different_ (assignment, student) is treated as a content collision and flagged for admin attention; this catches roster errors.

---

## 8. Cohort UI

### 8.1 Information architecture

- **Login** (`/login`).
- **Home** (`/`) — list of semesters the user has access to. Superadmin also sees an "all courses" admin view.
- **Semester** (`/s/:semesterSlug`) — the workhorse. Default tab = cohort list.
  - **Cohort** — paginated, filterable, sortable table of submissions (or students, toggle).
  - **Students** — student-level rollup table.
  - **Assignments** — per-assignment summary.
  - **Unmatched** — bundles awaiting manual attach.
  - **Ingest** — start a new ingest, see job status, see history.
  - **Roster** — view/upload/edit roster.
  - **Heuristics** — tune per-flag weights/thresholds, preview diff, commit + recompute.
  - **Members** — admin-only; manage who has access at what role.
  - **Settings** — retention, filename convention, semester slug, archive.
- **Submission** (`/s/:semesterSlug/sub/:submissionId`) — drill-in. Tabs: Overview, Replay, Timeline, Validation, Findings (export).
- **Student** (`/s/:semesterSlug/student/:studentId`) — every submission the student has in the semester, with score rollup and a small per-assignment sparkline.
- **Cross-flags** (`/s/:semesterSlug/cross-flags`) — list of `paste_shared_across_students` / `editing_pattern_clone` flags, with side-by-side compare derived from the existing v2 CompareView.
- **Local** (`/local`) — the v2 standalone SPA. No auth wrapper.

### 8.2 The cohort list — the central screen

The page the PI's feedback is most directly about. Design:

- **Top bar.** Semester switcher (only semesters the user can access), assignment filter, free-text student search.
- **Filter rail.**
  - Validation status (`pass`, `fail`, `warn`).
  - Flag presence — checkbox per heuristic id (with severity dot).
  - Severity threshold — radio (`info+`, `low+`, `medium+`, `high`).
  - Score range — two-handled slider.
  - Bundle-level signals: "has external edits," "has large paste," "extension hash mismatch," "shell integration disabled," etc.
  - "Hide superseded submissions" — default on.
- **Main table.** Columns: Student | Assignment | Score | High-severity flags (chips) | Validation | Ingested at | Recorder version. Sort by any. Click → submission drill-in.
- **View toggle.** "By submission" (default) ↔ "By student" — same filters, aggregated rows.
- **Export current view** button — emits CSV or markdown of the filtered list (for handing to a head TA).
- **Saved views.** A user can save a filter combination as a named view (e.g. "needs human review this week") scoped to themselves.

### 8.3 Per-submission drill-in

Reuses the v2 modules with their data sources swapped:

- `SubmissionOverview` — gets summary + flags + validation from `/api/v1/submissions/{id}/{flags,validation,stats}`. The summary block now also shows the (student, assignment, semester) breadcrumb.
- `Replay` — Monaco editor + transport bar + sidebar. File content + provenance fetched from `/api/v1/submissions/{id}/files/{path}/{content,provenance}?at_seq=N`. Events fetched lazily from `/api/v1/submissions/{id}/events` in pages keyed on global seq.
- `Timeline` — virtualized list backed by `/api/v1/submissions/{id}/events` with the same kind/file/session filters.
- `Findings export` — markdown unchanged (server-rendered), PDF unchanged (rendered server-side via jsdom + headless rasterizer of the same v2 components; details deferred to tech PRD).

### 8.4 Heuristic tuning UI

The tuning page is the most interactive piece of v3. Design:

- Two columns. Left: list of heuristics from `HEURISTIC_REGISTRY`, each with current weight, threshold knobs where applicable, on/off toggle. Right: live preview pane.
- The user adjusts a slider; the UI calls `PUT .../heuristic-config?dryRun=true` with the candidate config; the server returns:
  - count of submissions that would change tier (e.g. cross the `concerning` threshold),
  - top-10 movers (which specific submissions move the most),
  - aggregate score histogram before vs after.
- "Commit & recompute" button: persists the new config version, enqueues a recompute job, returns to the cohort list with a banner showing job progress.
- During a recompute, the cohort list shows a "stale" badge on rows whose `heuristic_config_version` is behind the active version; the row updates in place as workers complete it.

### 8.5 Cross-flag compare view

Adapts v2's `CompareView`. Two submissions side by side, common pasted text highlighted, scrubbable along a synchronized timeline. The cohort context adds: jump between cross-flag matches in the semester, attach a note to a cross-flag (visible to other admins).

### 8.6 Performance budgets (frontend)

- Cohort list under 500 rows: < 100ms render after API response.
- Cohort list 500–5000 rows: virtualized, < 200ms steady-state scroll.
- Submission drill-in cold load: < 1.5s for a typical 4-hour session bundle (replay loads events lazily; overview and validation are cheap).
- Tuning preview dryRun: < 800ms server-side for a semester of ~1000 submissions; UI is debounced 300ms.

---

## 9. Heuristic recompute pipeline

A recompute is triggered by:

- A new heuristic config version (manual tuning).
- An ingest finishing on a semester (cross-flags need to refresh).
- A manual admin action ("recompute everything").

A worker pulls jobs from a queue (`pg-boss` or `BullMQ`). Per submission, recompute:

1. Reads events from DB (not blob).
2. Reruns `runHeuristics` with the new config.
3. Diffs new flag set against old; writes new flag rows, soft-deletes obsolete ones (we keep history for audit).
4. Recomputes `score_total` and `score_max_flag_severity`.
5. Bumps `submissions.heuristic_config_version`.

Cross-flags are recomputed as a separate per-job step after all per-submission recomputes complete. They are cheaper to fully recompute than to diff, so we re-run the whole semester's cross-heuristics and replace the table partition for that (semester, config_version).

Failure semantics: a per-submission failure leaves the row at the old config version with an error logged; the job continues. The cohort list shows the row as "stale (recompute failed)" with the error available to admins.

---

## 10. Standalone SPA coexistence

- Same Vite build, same React app, same `src/index/` and `src/heuristics/` modules.
- Two route trees: one auth-wrapped (cohort) and one not (`/local`).
- The non-cohort SPA never imports the server-API client module; it imports the in-browser bundle parser exactly as v2 does today.
- Both trees share the per-submission viz modules. Those modules accept their data via a thin abstraction (e.g. a `SubmissionDataProvider` interface) with two impls: `InMemoryProvider` (parses `Bundle` in the browser) and `ApiProvider` (calls the v3 API). This is a small refactor of v2, not a rewrite.
- The `/local` route does not show login, navigation chrome of the cohort app, or any semester-aware UI. It looks and behaves exactly like v2.

---

## 11. Auth, identity, and authorization

### 11.1 Login

- **Google OAuth only**, restricted to the Berkeley Google Workspace tenant.
- The OAuth callback enforces two gates before any session is issued:
  1. `id_token.hd === 'berkeley.edu'` — the user's account is a member of the Berkeley Workspace, not a personal `@gmail.com` or another Workspace tenant.
  2. `id_token.email_verified === true`.
     Either check failing returns the user to `/login` with an explicit error explaining that only Berkeley accounts can sign in.
- The `hd` allowlist is a single-entry list in config (`AUTH_ALLOWED_HOSTED_DOMAINS=["berkeley.edu"]`) so a future need (e.g. piloting at another institution) is a config change, not a code change.
- First successful login of a new user creates a `users` row with no memberships. Superadmin or a semester admin must explicitly invite them. The Workspace check authenticates _who you are_; membership grants _what you can see_. There is no auto-claim by email pattern.
- Invitations are stored as pending memberships keyed by email; on first login matching the email, the membership flips active.
- No CalNet/SAML, no GitHub, no magic links, no password fallback. Lost-access recovery is "the superadmin re-invites you" or "fix your Google account."

### 11.2 Tokens

- Per-user API tokens via `/api/v1/me/tokens`. Each token has a label, a hashed value (never stored in plaintext), optional scope reduction, optional expiry.
- Tokens scope to _the user's existing memberships_; a token can't grant access the user doesn't have. Reducing scope on a token can narrow further (read-only, single semester, etc.).
- Public docs (§14) include an SDK-quality "how to call the API from Python" page using tokens.

### 11.3 Authorization decisions

A single `authorize(principal, action, target)` function. `action ∈ {'read', 'write', 'admin'}`. `target` is a tuple identifying a resource (semester/submission/cross-flag/etc.). Decision tree:

- Superadmin: yes.
- Else, find principal's membership on the target's semester. If none, deny.
- Role check: `admin` actions require `admin`; `write` requires `admin`; `read` allowed for `admin` or `grader`.
- Token scope reductions apply _after_ the role check (intersection).

### 11.4 Audit

Every write action and every blob download is appended to `audit_log`. Reads of the cohort list are NOT logged (too high-volume). Reads of an individual submission ARE logged. Audit retention is the longest of all retention policies.

---

## 12. Operational concerns

### 12.1 FERPA / privacy

- Data is student academic work; FERPA applies. The Berkeley IT and Registrar review is a prerequisite to launch and is out of scope for this design doc.
- Data minimization: roster columns beyond `(sid, display_name, email)` are stored as opaque `extras_jsonb` and only displayed in views that explicitly need them.
- Right of review (PRD §9): preserved via the markdown/PDF export, which a staff member can hand to a student. No student login in v3.
- Cross-institution data sharing: prohibited by design. Tokens are user-scoped; there is no "course-share" credential.

### 12.2 Retention

- `semester.blob_retention_days` controls when blobs are eligible for deletion after the semester's `archived_at`. Default proposed: 540 days (~18 months — covers a one-year appeal window plus margin). Settable per semester.
- Derived rows (events, flags, scores) retained longer — default 5 years — to support term-over-term trend dashboards and integrity case histories.
- Hard delete of a submission (e.g. successful student appeal): admin action, audit-logged, cascades blob + events + flags + score + per_file_stats + cross-flag participation. Records the deletion reason.

### 12.3 Backups & DR

- Postgres PITR via WAL archival to object storage. RPO target: 1 hour. RTO target: 4 hours. Tested via quarterly restore drills.
- Object storage cross-region replication if the chosen provider supports it; otherwise periodic mirroring to a second bucket.
- Disaster scenarios (region outage, accidental drop, corruption) all recoverable to RPO.

### 12.4 Observability

- Structured logs (JSON) emitted by every API request with principal, route, latency, outcome.
- Metrics: API latency by route, ingest throughput, recompute lag, worker queue depth, blob download counts.
- Alerting on: API error rate > 1%, recompute lag > 1 hour, worker queue depth > N.

### 12.5 Cost posture

CS 61A scale (rough order-of-magnitude — to be confirmed in Open Question B):

- ~3000 students × ~10 assignments × ~5 MB median bundle ≈ 150 GB per semester in object storage.
- ~3000 × 10 × ~10,000 events ≈ 300M event rows per semester — at the upper end of the "single table" comfort zone. May force the partitioning revisit noted in §6.2.
- Postgres sizing: ~50 GB primary, with a read replica if cohort-list latency demands it.

These numbers are speculative until Open Question B is answered.

---

## 13. What v3 explicitly does _not_ include

- **LLM-assisted review (PRD §7.6).** Out of scope for this transition. The API surface exposes everything an LLM client would need (events, flags, stats, file content, provenance), so v3.x can layer it on without further server changes.
- **Student-facing accounts.** No student login, no in-product right-of-review flow. Continues to be handled out-of-band via the markdown/PDF export.
- **LMS / Gradescope pull integration.** The filename-convention design is deliberately compatible with a future API-pull source, but the integration itself is not v3.
- **Real-time collaboration.** No multi-user cursors on the cohort list, no concurrent tuning. Last-write-wins on heuristic config with a version conflict warning.
- **Custom heuristics by end users.** Heuristics remain code-defined. Per-semester _config_ (weights/thresholds/on-off) is the tuning surface, not new logic.
- **Mobile UI.** Cohort review is a desktop activity.

---

## 14. Documentation deliverables (alongside v3 itself)

Because the API is documented and public, v3 ships with:

- **OpenAPI 3.1 spec** auto-generated from route handlers.
- **API reference docs** (rendered from the OpenAPI, e.g. via Redoc) at `/api/v1/docs`.
- **Quickstart guides** at `/docs/`: "Bulk-uploading bundles," "Querying the cohort from Python," "Configuring filename conventions."
- **Admin guide**: hosting, Google OAuth client setup (with the `berkeley.edu` `hd` restriction), retention, backup/restore drill instructions.
- **Migration note for v2 SPA users**: the `/local` route preserves the old experience; no action needed for one-off review.

---

## 15. Open issues and risks

A. **FERPA / Berkeley IT posture** — VM ownership, backup policy, registering the Google OAuth client under a CS 61A-owned Google Cloud project, key management. Blocks production launch, not design. Tracked separately.

B. **Real semester scale** — confirm per-bundle median size, peak submissions per assignment, peak events per bundle. Affects partitioning, worker sizing, and storage cost. Likely answer: order-of-magnitude in §12.5.

C. **Re-upload semantics** — current design: version-and-keep, supersede the older row. Alternative: reject if non-identical. Default proposed; user to confirm.

D. **Retention defaults** — proposed 18 months for blobs, 5 years for derived. User and course staff to confirm.

E. **Standalone SPA hosting** — same origin (`/local`) is the proposed default. A separate origin is possible if there's a content-security or branding reason; not aware of one.

F. **Cross-flag recompute cost at scale** — `editing_pattern_clone` is O(N²) on submissions per assignment. At ~3000 students per assignment, the naive comparison is 4.5M pairs. The current v2 implementation uses early-termination on dissimilar pairs; need to confirm it scales or add bucketing (e.g. LSH on event-sequence shape).

G. **Heuristic config version churn** — frequent tuning during a calibration period could thrash the recompute queue. Mitigation: rate-limit config commits (e.g. one per 5 minutes per semester), batch overlapping recompute requests.

H. **Backwards-compat with v2 bundles** — v3 must accept the current bundle format (format_version 1.0). PRD §5.1 already pins this. If/when a future recorder version emits a new format, v3 accepts both for a deprecation window.

I. **Schema migration story** — Postgres migrations via a tracked tool (Prisma / Drizzle / Kysely + node-pg-migrate, TBD in tech PRD). Forward-only; backout via PITR restore for emergencies.

J. **The "no student login" decision** is reversible — could add later without disrupting existing data. Worth noting because it's a likely product-evolution direction.

---

## 16. Decision log

Each decision below was made during brainstorm or in this doc; reference the question or section in parentheses.

| #   | Decision                                                                                                              | Alternatives considered                                                 | Why                                                                                                                                                                                    |
| --- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Single Berkeley-hosted shared instance                                                                                | self-hosted per course, local-only desktop app, cloud SaaS multi-tenant | Centralized review matches the PI directive; SaaS overkill; local-only blocks TA collaboration                                                                                         |
| 2   | Course → Semester → Assignment → Submission hierarchy with per-semester access grants and a Superadmin tier           | Assignment-scoped, course-scoped                                        | Matches user's stated delegation model; per-semester is the natural grant boundary                                                                                                     |
| 3   | Roster CSV + filename convention regex + unmatched tray                                                               | Sidecar manifest in each bundle, manual mapping only, LMS pull          | Lowest-friction for course staff; PRD §4.1 doesn't add anything to the bundle; LMS pull deferred                                                                                       |
| 4   | Score = per-submission weighted Σ(severity×confidence); student-level sum default, max alt                            | per-submission only, two scores (heuristic + LLM), full custom rubric   | Matches user's "overall score + tune the heuristics" framing; LLM split deferred to v3.x                                                                                               |
| 5   | Bundle blob in object storage; **events materialized into Postgres at ingest**; flags/stats/score derived in Postgres | events stay in blob with lazy index, hybrid, derived-only               | API-first directive demands cheap cross-submission event queries; materializing is the only way                                                                                        |
| 6   | Google OAuth only, restricted to `berkeley.edu` Workspace (`hd` claim)                                                | Pluggable OIDC, CalNet/SAML, GitHub, magic links                        | All real users are on bConnected anyway; Workspace `hd` check is a one-line guarantee that beats trusting `email.endsWith('@berkeley.edu')`; removes IdP-integration scope from launch |
| 7   | API-first; documented public surface; per-user API tokens; OpenAPI spec; rate limits                                  | internal-only, internal-now-public-later                                | PI feedback was unambiguous; the cost is real but matched to the directive                                                                                                             |
| 8   | Keep v2 viz modules; replace v2's data-source with API client; standalone drop-a-zip SPA preserved at `/local`        | Replace v2 entirely; standalone separate origin                         | v2 modules are tested and the data shapes already line up; `/local` preserves ad-hoc workflow                                                                                          |
| 9   | Heuristic config is semester-scoped; tuning generates a new version; recompute is a background job                    | per-assignment config, global config, in-place mutation                 | Matches user's stated tuning scope; versioning preserves audit history                                                                                                                 |
| 10  | Re-uploads create a new submission version; old rows kept as `superseded_by_submission_id`                            | overwrite, reject                                                       | Preserves history without complicating queries; default for cohort view excludes superseded                                                                                            |
| 11  | Cross-submission heuristics run per ingest job at semester scope                                                      | per-pair on demand, scheduled batch                                     | Need fresh results after every ingest; lazy on-demand makes cohort flags unreliable                                                                                                    |

---

## 17. Phasing outlook (not the implementation plan)

The full implementation plan lives in a separate doc (to be drafted after the technical PRD lands). For shape only:

- **Phase A — backend skeleton.** Server scaffold, Google OAuth (with the `hd === 'berkeley.edu'` gate), Postgres + migrations, object storage wiring, audit, basic auth. Minimal endpoints (`/me`, courses/semesters CRUD).
- **Phase B — ingest pipeline.** Roster upload, bundle parse, dedup, student match, events materialization, per-file stats, validation. Unmatched tray.
- **Phase C — heuristics on server.** Port the full v2 heuristic suite to run server-side; flag/score rows; per-semester config + recompute workers.
- **Phase D — API completion + OpenAPI.** All resources from §5; auto-generated spec; rate limiting; token CRUD.
- **Phase E — Cohort UI front-of-house.** Login, semester home, cohort list, filters/sorts, student & assignment rollups.
- **Phase F — Per-submission drill-in.** Wire v2 modules to the API via the `SubmissionDataProvider` abstraction. Keep replay/timeline/overview/export working.
- **Phase G — Tuning UI + cross-flag UI.** Live preview, commit + recompute, side-by-side compare.
- **Phase H — Hardening & ops.** Backups, alerting, docs, admin guide, FERPA review handoff.
- **Phase I — Standalone SPA at `/local`.** Refactor data-source abstraction; both modes share modules; smoke tests both paths.

Each phase ends with a tagged release; each phase has its own internal phase-by-phase plan in the implementation doc.

---

## 18. What comes next

This design doc is the input to two follow-on documents:

1. **`docs/analyzer-v3-prd.md`** — technical PRD, pinning every API route's schema, every Postgres column, every config knob, every error code. Driven by §§5–9 of this doc.
2. **`docs/analyzer-v3-implementation-plan.md`** — phased implementation plan, modeled on the v2 plan's structure. Driven by §17 of this doc and the technical PRD.

The order is intentional: the technical PRD makes the data and API contracts concrete; the implementation plan sequences the work that builds against those contracts. We do not start implementation until both are approved.
