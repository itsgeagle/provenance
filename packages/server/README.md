# @provenance/server

Node.js API server for the Provenance Analyzer v3.

Current schema version: **0012** (cross_flags + cross_flag_participants, Phases 0–14).

## Dev quickstart

### 1. Start backing services

```bash
# From the repo root
docker compose up -d
```

This starts Postgres 16 (port 5432) and MinIO (ports 9000/9001).
The MinIO web console is at http://localhost:9001 (user: `minioadmin`, password: `minioadmin`).

Create the storage bucket (one-time):

```bash
docker compose exec minio mc alias set local http://localhost:9000 minioadmin minioadmin
docker compose exec minio mc mb local/provenance
```

### 2. Configure environment

```bash
cp .env.example .env
# Fill in GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET from Google Cloud Console.
```

See `docs/analyzer-v3-prd.md §3` for the full env var reference.

### 3. Run the server

```bash
npm run dev --workspace=packages/server
```

`npm run dev` runs in `--mode=all`: the HTTP API **and** the pg-boss worker in one
process, so uploaded bundles are actually ingested. Override with
`npm run dev --workspace=packages/server -- --mode=api` to run the API alone.

Verify:

```bash
curl localhost:3000/healthz
# {"status":"ok"}
```

## Run modes

```bash
# API server only (no background jobs)
node dist/index.js --mode=api

# Worker only (pg-boss job handlers + cron jobs)
node dist/index.js --mode=worker

# Both in one process — for single-machine dev / staging (what `npm run dev` uses)
node dist/index.js --mode=all
```

Mode defaults to `api` when no flag is given. The last `--mode=` wins, so a script
default can be overridden on the command line. In production, run `--mode=api` and
`--mode=worker` as separate processes so they can be scaled independently.

## Seeding example data

`npm run seed` populates a local database with an example cohort so other staff can
click around the analyzer without hunting for real submissions. It does the realistic
thing end to end: it generates a Gradescope export ZIP and runs it through the **real**
ingest pipeline (the same `POST /ingest:gradescope` route + worker that production uses).

Prerequisites are the same as `npm run dev`: `docker compose up -d`, the MinIO bucket
created (step 1 above), `.env` present, and migrations applied. Then:

```bash
npm run seed --workspace=packages/server
```

What it creates (all under an isolated `seed-demo` semester, so it never collides with
a real one):

- a `CS 61A (seed)` course + `Seed Demo — CS 61A` semester,
- five rostered students including one **group submission** (two co-submitters share a
  bundle) and one student who submitted **without the recorder** (skipped, but rostered),
- one assignment (`hw10`) with a recorder bundle per student, fully ingested (events,
  per-file stats, validation, heuristics).

Flags and notes:

- **Idempotent by default.** Re-running once `seed-demo` is populated is a no-op. The
  server rebuilds each bundle ZIP on ingest with non-stable archive metadata, so a
  re-ingest would otherwise stack a new submission *version* per student.
- **`--regenerate`** rebuilds the committed example export
  (`scripts/seed/example-gradescope-export.zip`) and forces a fresh ingest:
  `npm run seed --workspace=packages/server -- --regenerate`. The export content
  (students, event timelines) is deterministic; only the per-build signing key differs.
- **Viewing it.** The seed authors the ingest as a synthetic `seed-admin@berkeley.edu`
  user (not a real login). To see the data in the analyzer UI, add your own Google email
  to `AUTH_SUPERADMIN_EMAILS` in `.env`, restart the server, and sign in — superadmins
  see every semester.

The example export ZIP is committed, so you can also upload it manually via the UI or
`POST /ingest:gradescope` against any semester you own.

## Cron jobs (Phase 25)

Three scheduled jobs are registered in pg-boss on worker startup:

| Job                      | Cron (UTC)  | Description                                          |
| ------------------------ | ----------- | ---------------------------------------------------- |
| `retention_sweep`        | `0 2 * * *` | Purge blobs past semester retention window (PRD §16) |
| `purge_expired_sessions` | `0 * * * *` | DELETE expired session rows                          |
| `purge_expired_exports`  | `0 3 * * *` | Stub — export artifacts (v3.1)                       |

Handler sources: `src/jobs/retention-sweep.ts`, `src/jobs/purge-expired-sessions.ts`,
`src/jobs/purge-expired-exports.ts`. Registered via `boss.schedule()` in `src/jobs/worker.ts`.

## Database migrations

### Apply migrations

```bash
# Run all pending migrations against DATABASE_URL
npm run db:migrate --workspace=packages/server
```

### Generate a new migration after editing the schema

```bash
# 1. Edit packages/server/src/db/schema.ts
# 2. Run drizzle-kit to generate the migration SQL:
npm run db:generate --workspace=packages/server
# 3. Review the generated file in packages/server/db/migrations/.
#    drizzle-kit cannot express partial/functional indexes — hand-edit those.
#    Pattern: grep for "IMPORTANT: hand-edit" comments in the schema for known gaps.
# 4. Apply to local dev DB:
npm run db:migrate --workspace=packages/server
# 5. Commit both schema.ts and the new .sql migration file together.
# 6. Update the "Current schema version" in this README.
```

**Migrations through 0012:**

| Migration | Contents                                                                              |
| --------- | ------------------------------------------------------------------------------------- |
| 0001      | users, sessions, courses, semesters, memberships, roster_entries, pending_invitations |
| 0002      | api_tokens                                                                            |
| 0003      | rate_limit_buckets                                                                    |
| 0004      | audit_log                                                                             |
| 0005      | roster_entries (index fix)                                                            |
| 0006      | ingest_jobs, ingest_files, assignments, submissions                                   |
| 0007      | events, per_file_stats                                                                |
| 0008      | validation_results                                                                    |
| 0009      | flags                                                                                 |
| 0010      | heuristic_configs, recompute_jobs                                                     |
| 0011      | (reserved)                                                                            |
| 0012      | cross_flags, cross_flag_participants                                                  |

Migrations are stored in `packages/server/db/migrations/` and tracked by
`meta/_journal.json`. The `db:migrate` script runs `drizzle-orm`'s migrator
directly (no drizzle-kit CLI needed at runtime).

> **npm workspaces note:** `drizzle-kit` is hoisted to the repo root by npm
> workspaces, but `drizzle-orm` lives in `packages/server/node_modules/`.
> If `npm run db:generate` errors with "Please install latest version of
> drizzle-orm", create a temporary symlink in the repo-root `node_modules/`:
>
> ```bash
> ln -s packages/server/node_modules/drizzle-orm node_modules/drizzle-orm
> ```
>
> Remove it after generating the migration. A permanent fix is to move
> `drizzle-kit` to the root `devDependencies` alongside `drizzle-orm`.
> (Tracked in TODO — needs approval per CLAUDE.md.)

### Testcontainers requirement

Integration tests (`src/db/*.test.ts`, `test/helpers/*.test.ts`) spawn a
real Postgres 16 container via testcontainers. **Docker must be running** on
the host when you run `npm run test`. Tests are skipped (with a clear error)
if Docker is unavailable.

Each test case gets its own container and database, so tests are fully
isolated with no shared state.

## Scripts

| Script                | Description                                |
| --------------------- | ------------------------------------------ |
| `npm run dev`         | Dev server with file-watching via tsx      |
| `npm run build`       | Bundle to `dist/index.js` via esbuild      |
| `npm run start`       | Run the production bundle                  |
| `npm run test`        | Run unit + integration tests (vitest)      |
| `npm run typecheck`   | Type-check without emit                    |
| `npm run lint`        | ESLint                                     |
| `npm run db:migrate`  | Apply pending migrations to DATABASE_URL   |
| `npm run db:generate` | Generate new migration from schema changes |

## Environment variables

See `docs/analyzer-v3-prd.md §3.1` for the full table. A copy with local-dev defaults is in `.env.example`.
