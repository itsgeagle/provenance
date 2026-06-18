# Provenance

**A CS 61A academic-integrity telemetry and analysis system.**

Provenance has two halves that share one artifact:

1. **Provenance Recorder** — a VS Code extension that runs while a student works on an assignment and produces a tamper-evident log of how the code came into existence.
2. **Provenance Analyzer v3** — a full-stack web app used by course staff to ingest, score, and review those logs at scale. Includes: a cohort list with filter/sort/export, per-submission drill-in with timeline replay and validation, a heuristics tuning UI, cross-submission paste detection, and a standalone offline mode (`/local`) that runs entirely in-browser.

The full design lives in [`docs/prd.md`](docs/prd.md). Code conventions for working in this repo are in [`CLAUDE.md`](CLAUDE.md).

## Status

| Component           | Status                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/log-core` | **Complete** — event types, JCS canonicalization, hash chain, validator, ndjson serialization, bundle and manifest shapes, ed25519 manifest verification. 125 unit tests.                                                                                                                                                                                                                     |
| `packages/recorder` | **v1.1 complete** — all PRD §4 event types, three-signal paste detection, external-change detection, per-session signing keypair, signed checkpoints, chain recovery, bundle seal, disk-full degraded mode, initial-content capture on `doc.open` (v1.1). 255 unit tests + integration tests against real VS Code.                                                                            |
| `packages/shared`   | **v3 complete** — Zod schemas shared between server and analyzer for type-safe API contracts.                                                                                                                                                                                                                                                                                                 |
| `packages/analyzer` | **v3 complete** — Full cohort + per-submission flow. Google OAuth login, semester switcher, cohort list (virtualized, filterable, sortable), per-submission drill-in (overview / timeline / replay / validation), heuristics tuning (24-slider UI, dry-run diff, recompute), cross-flags view, export panel. Standalone `/local` mode (v2 drop-a-zip UX, no auth required). 1000+ unit tests. |
| `packages/server`   | **v3 complete** — Node.js + Hono API server. PostgreSQL + Drizzle ORM. Google OAuth + sessions + API tokens. Ingest pipeline (ZIP → parse → match → heuristics → cross-flags). pg-boss job queue. OpenAPI 3.1 spec + Redoc. Prometheus metrics. Retention sweep + session purge cron jobs. 800+ integration tests.                                                                            |

See [`docs/analyzer-v3-implementation-plan.md`](docs/analyzer-v3-implementation-plan.md) for the v3 build history (26 phases).

## Quickstart — development environment

Requires Node 22+ and npm 10+. Docker is required to run the server (Postgres + MinIO via `docker compose`).

```sh
git clone <repo> provenance
cd provenance
npm install
```

### Run all tests

```sh
npm run build && npm run typecheck && npm run lint && npm run test
```

### Run the analyzer v3 server (API + worker)

```sh
# Start Postgres + MinIO
docker compose up -d

# Configure environment (fill in Google OAuth credentials)
cp packages/server/.env.example packages/server/.env

# Run migrations
npm run db:migrate --workspace=packages/server

# Start server (API + worker combined)
npm run dev --workspace=packages/server
```

The server starts on `http://localhost:3000`. Swagger UI at `http://localhost:3000/api/v1/docs`.

### Run the analyzer frontend

```sh
npm run dev --workspace=packages/analyzer
```

Visit `http://localhost:5173`. Sign in with a Google account in `AUTH_ALLOWED_HOSTED_DOMAINS`.

### Offline / local mode (no server required)

Visit `http://localhost:5173/local/load` and drop a `.zip` bundle. No authentication
is required. This is the preserved v2 "drop a zip" UX. It runs entirely in-browser —
no data leaves your machine.

### Run the recorder extension

Open this repo in VS Code and press Fn + F5 (or pick **"Run Recorder Extension"** in the
Run & Debug panel). A second VS Code window opens with `test-workspace/` loaded; the
status bar shows "CS 61A: recording".

For richer recorder instructions see [`docs/recorder.md`](docs/recorder.md).
The student-facing description that ships with the VSIX lives at
[`packages/recorder/README.md`](packages/recorder/README.md).

### Documentation

- [`docs/admin-guide.md`](docs/admin-guide.md) — hosting, Google OAuth setup, retention policy, backups, restore drill
- [`docs/api-quickstart.md`](docs/api-quickstart.md) — Python and curl examples for the v3 API
- [`packages/server/README.md`](packages/server/README.md) — server-specific dev instructions

## Repo layout

```
provenance/
├── docs/
│   ├── prd.md                          # recorder product spec
│   ├── analyzer-v3-prd.md              # analyzer v3 product spec
│   ├── analyzer-v3-implementation-plan.md # 26-phase build plan
│   ├── admin-guide.md                  # hosting + operations guide
│   └── api-quickstart.md               # Python + curl API examples
├── packages/
│   ├── log-core/              # shared event types, hash chain, format
│   ├── recorder/              # VS Code extension (v1.1 complete)
│   ├── shared/                # Zod API schemas shared by server + analyzer
│   ├── analyzer/              # SPA frontend (v3 complete)
│   └── server/                # Node.js API server (v3 complete)
├── tools/                     # dev scripts (key generation, manifest signing)
├── test-workspace/            # sample student workspace for dev & integration tests
├── compose.yaml               # Docker Compose for Postgres + MinIO
├── CLAUDE.md                  # repo conventions for Claude Code
└── package.json               # npm workspace root
```

## Architecture rules (enforced)

- `packages/log-core` has zero runtime dependencies on VS Code, Node-only APIs, or the DOM. It's pure TypeScript that runs in any JS environment. An ESLint `no-restricted-imports` rule on `packages/log-core/**/*.ts` rejects `vscode`, `node:*`, `fs`, `path`, `worker_threads`, `crypto` imports.
- `packages/recorder` depends on `log-core`, `vscode`, and a small fixed set of approved libraries (`@noble/ed25519`, `@noble/hashes`, `@noble/ciphers`, `canonicalize`, `jszip`). The packaged VSIX is ESM (requires VS Code ≥ 1.94).
- The log file format is the contract between recorder and analyzer. It's specified in PRD §5 and pinned with test vectors in `packages/log-core/src/hash-chain.test.ts`.

## Common commands

| Command                                                  | What it does                                                                      |
| -------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `npm run build`                                          | TypeScript build for both packages.                                               |
| `npm run test`                                           | Vitest unit tests across all workspaces (~1200 total).                            |
| `npm run typecheck`                                      | `tsc --noEmit` across the workspace.                                              |
| `npm run lint`                                           | ESLint + Prettier check.                                                          |
| `npm run package:recorder`                               | Build the VSIX (`.vsix` file) for local installation.                             |
| `npm run test:integration --workspace packages/recorder` | Download VS Code 1.120 and run integration tests against the real Extension Host. |
| `npm run bench --workspace packages/recorder`            | Run the SessionWriter perf benchmark (p99 should be << 1ms).                      |

## Course staff: key & manifest workflow

The recorder verifies every `.cs61a` manifest against an ed25519 public key embedded in the extension. The keypair is generated **offline** on a secured machine; the private key never enters the repo.

**Generate the course keypair** (once, on a secured machine):

```sh
node --experimental-strip-types tools/generate-course-keypair.ts /Volumes/SECURE/cs61a-fa26.json
```

The public key is printed to stdout (paste into a clipboard or pipe into the production build). The private key is written to the chosen path with mode `0600`. Back it up to physical media.

**Author the unsigned `.cs61a`** in the assignment starter folder. Drop this file at the workspace root the students will open:

```json
{
  "assignment_id": "hw03",
  "semester": "fa26",
  "issued_at": "2026-09-15T00:00:00Z",
  "files_under_review": ["hw03.py"]
}
```

Field rules (enforced by `parseManifest` in `packages/log-core/src/cs61a-manifest.ts`):

- `assignment_id` — non-empty string, unique per assignment. Rotating it per assignment is what prevents replay of an old session against a new assignment (PRD §6).
- `semester` — non-empty string, e.g. `"fa26"`.
- `issued_at` — non-empty ISO 8601 UTC timestamp.
- `files_under_review` — array of workspace-relative paths. Only files in this list get the in-memory expected-content model used for external-change detection (PRD §4.5). Other files are still recorded for workspace context.

Omit the `sig` field; the signer adds it. (If you re-sign an already-signed manifest, the old `sig` is stripped first.)

**Sign a per-assignment manifest** (every time a new assignment is released):

```sh
PROVENANCE_COURSE_KEYPAIR_PATH=/Volumes/SECURE/cs61a-fa26.json \
  node --experimental-strip-types tools/sign-cs61a-manifest.ts /path/to/assignment-starter/.cs61a
```

The script strips any existing signature, canonicalizes the remaining fields (via JCS), signs with the private key, and writes the updated `.cs61a` back to disk.

**Produce a production VSIX** with the course public key embedded:

```sh
PROVENANCE_COURSE_PUBLIC_KEY_HEX=<64-hex-from-generate-step> \
  npm run build:prod --workspace packages/recorder
```

`build:prod` embeds the production key, builds, packages a VSIX, then restores the source file so further local work uses the dev key. The script refuses to run if the env var is missing, malformed, or matches the dev key — so a misconfigured release can never silently ship a dev VSIX.

**Refresh the analyzer's known-good extension-hash list** so the new VSIX won't trip `extension_hash_mismatch` when staff load real submissions:

```sh
npm run update-hashes -- --keypair /Volumes/SECURE/cs61a-fa26.json
```

This runs the same `build:prod` pipeline as above (you can re-use the same keypair JSON instead of exporting the env var by hand), then hashes the bundled `dist/` and appends the result to `packages/analyzer/src/heuristics/config/known-good-extension-hashes.json`. The script computes the hash with the same algorithm the recorder uses at seal time, so any VSIX produced by the same run will validate cleanly. Without `--keypair` (and with no `PROVENANCE_COURSE_PUBLIC_KEY_HEX` env var) the script falls back to bundling with the dev key and prints a loud warning — that hash will never match a real release.

Other modes: `--show` (print current list), `--no-build` (hash an already-bundled `dist/`), `--hash <hex>` / `--remove <hex>` (manual entries), `--clear`.

See [`docs/recorder.md`](docs/recorder.md) for the full security model and what the recorder defends against.
