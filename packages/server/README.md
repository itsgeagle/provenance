# @provenance/server

Node.js API server for the Provenance Analyzer v3.

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

Verify:

```bash
curl localhost:3000/healthz
# {"status":"ok"}
```

## Run modes

```bash
# API server (default)
node dist/index.js
node dist/index.js --mode=api

# All modes (currently boots API only; worker added in Phase 12)
node dist/index.js --mode=all

# Worker only (stub until Phase 12)
node dist/index.js --mode=worker
```

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
#    If the generated SQL differs from the intended DDL (e.g. missing partial
#    unique index, wrong expression default), hand-edit it to match.
# 4. Commit both schema.ts and the new .sql file together.
```

Migrations are stored in `packages/server/db/migrations/` and tracked by
`meta/_journal.json`. The `db:migrate` script runs `drizzle-orm`'s migrator
directly (no drizzle-kit CLI needed at runtime).

### Testcontainers requirement

Integration tests (`src/db/*.test.ts`, `test/helpers/*.test.ts`) spawn a
real Postgres 16 container via testcontainers. **Docker must be running** on
the host when you run `npm run test`. Tests are skipped (with a clear error)
if Docker is unavailable.

Each test case gets its own container and database, so tests are fully
isolated with no shared state.

## Scripts

| Script              | Description                                   |
| ------------------- | --------------------------------------------- |
| `npm run dev`       | Dev server with file-watching via tsx         |
| `npm run build`     | Bundle to `dist/index.js` via esbuild         |
| `npm run start`     | Run the production bundle                     |
| `npm run test`      | Run unit + integration tests (vitest)         |
| `npm run typecheck` | Type-check without emit                       |
| `npm run lint`      | ESLint                                        |
| `npm run db:migrate`| Apply pending migrations to DATABASE_URL      |
| `npm run db:generate`| Generate new migration from schema changes   |

## Environment variables

See `docs/analyzer-v3-prd.md §3.1` for the full table. A copy with local-dev defaults is in `.env.example`.
