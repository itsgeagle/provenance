# EECS apphost deployment infrastructure

**Date:** 2026-07-10
**Status:** Approved (design), pending implementation
**Scope:** `packages/server` (a little runtime code) + new repo-root deploy artifacts + docs.
**Depends on:** the fs blob-storage backend (branch `feat/filesystem-blob-storage`, PR #8)
and the operational-notifications feature (built first, same branch).

## Motivation

Stand Provenance up on the EECS Instructional apphost (`instapphost.eecs.berkeley.edu`,
public `https://provenance.eecs.berkeley.edu`), storing bundles on the 1TB-quota'd NFS mount
`/home/submit/provenance`. The apphost's model (from its `apphost.help`):

- nginx terminates TLS and proxies to the app over a **Unix domain socket** at
  `/srv/appsockets/provenance/main/app.sock` (world-writable so nginx can write it). No TCP
  port is exposed for web apps.
- **Rootless Docker** (`inst-dockerd-rootless-setup.sh`). Bind mounts show host-owned files
  as `root` inside the container; **writing an NFS bind mount requires running as root
  inside the container**. Named volumes are recommended for persistent storage.
- Startup is a **systemd _user_ unit** (`ConditionPathExists=/etc/is-instapphost`,
  `Restart=always`, `docker compose up/down`).

CI/CD is explicitly **out of scope** — GitHub's hosted runners can't reach `instapphost`, so
deploy is a documented manual runbook run on the host over SSH.

## Non-goals

- No GitHub Actions / registry / image push. Build happens on the host (`docker compose
build`).
- Not migrating the app to the apphost MariaDB. Provenance is Postgres-specific; we
  self-host a Postgres container (see the Postgres-on-NFS risk below).
- No TLS/reverse-proxy in our stack — IT's nginx owns TLS termination.

## Deliverables

### 1. Unix-socket serving (server code)

`packages/server/src/api/start.ts` currently listens on a numeric `PORT` via
`@hono/node-server` `serve()`. Add socket support: a new `SOCKET_PATH` env (optional). When
set, the server listens on that Unix socket instead of a TCP port, removes any stale socket
file first, and after `listen` sets the socket **world-writable** (`chmod 0o777`, or umask
`000` at create) so nginx can write it. When unset, TCP `PORT` behavior is unchanged (dev).
If `@hono/node-server`'s `serve()` cannot bind a socket path directly, drop to
`node:http.createServer(getRequestListener(app.fetch))` + `server.listen(SOCKET_PATH)`. The
listen/chmod logic is factored into a testable helper.

### 2. SPA static serving (server code)

The server must serve the built analyzer SPA from the same origin as the API (one hostname).
Add static serving (via `@hono/node-server`'s `serveStatic`) mounted **after** the API
routes: serve files from a `PUBLIC_DIR` (default `./public`, the analyzer `dist/` copied
into the image), with SPA fallback to `index.html` for any non-file, non-`/api`, non-
`/healthz` path. `/api/v1/*` and `/healthz` continue to win. The analyzer's `VITE_API_BASE_URL`
default (`/api/v1`) already makes same-origin work with no rebuild flag.

### 3. Multi-stage Dockerfile (`packages/server/Dockerfile` or repo-root `Dockerfile`)

- **Stage 1 (analyzer build):** install workspace deps, `vite build` the analyzer → `dist/`.
- **Stage 2 (server build):** esbuild-bundle the server → `dist/index.js`.
- **Runtime stage:** `node:22` slim, copies the server bundle, the analyzer `dist/` into
  `PUBLIC_DIR`, node_modules needed at runtime (or fully bundled), and the entrypoint. Bakes
  `GIT_SHA` as a build arg (surfaced by the startup notification). **Runs as root** (needed
  to write the NFS bind mount per the apphost model — documented inline). Installs
  `postgresql-client`? No — pg_dump lives in the sidecar, not this image. Entry via the
  entrypoint script.

### 4. Entrypoint (`deploy/entrypoint.sh`)

Runs `node dist/db/migrate.js` (Drizzle migrator, idempotent) then `exec node dist/index.js
--mode=all`. Fails fast (non-zero) if migration fails, so a bad migration doesn't boot a
half-running app.

### 5. `deploy/compose.apphost.yaml`

Three services:

- **app** — built from the Dockerfile; `env_file: .env`; bind-mounts
  `/home/submit/provenance → /data` (so `BLOB_STORAGE_FS_ROOT=/data`) and
  `/srv/appsockets/provenance/main → /run/sockets` (so `SOCKET_PATH=/run/sockets/app.sock`);
  runs as root; `depends_on: postgres`; `restart: unless-stopped`.
- **postgres** — `postgres:16`; **named volume** for `PGDATA` (per apphost guidance);
  non-default published port bound to localhost only; healthcheck; `restart: unless-stopped`.
  ⚠️ **Risk:** rootless Docker's volume store is under the NFS home, so this volume is
  NFS-backed — the classic "Postgres on NFS" footgun. Mitigations: the nightly `pg_dump` is
  the recovery guarantee, and the runbook asks IT whether the Docker data-root/volume can
  live on local disk. Documented as a coordination item, not silently accepted.
- **pg_dump sidecar** — `postgres:16` (matched client); a small loop/cron that runs
  `pg_dump -Fc` nightly into `/data/backups/`, rotates to the last `PGDUMP_KEEP` (default 7),
  and pings `HEALTHCHECKS_URL` (a free healthchecks.io dead-man's-switch) on success so a
  silently-failing backup is detected. Decoupled from the app lifecycle (runs even if the app
  is down).

### 6. systemd user unit (`deploy/provenance.service`)

Checked-in unit mirroring the apphost doc: `ConditionPathExists=/etc/is-instapphost`,
`After=docker.service`, `WorkingDirectory` at the compose dir, `ExecStartPre` removing the
stale socket + `docker compose down`, `ExecStart=docker compose -f compose.apphost.yaml up`,
`ExecStop=docker compose down`, `Restart=always`.

### 7. Quota-check cron (server code, uses the notifier)

A pg-boss cron (`storage_quota_check`, hourly) that `statfs`-checks `BLOB_STORAGE_FS_ROOT`'s
usage against `STORAGE_QUOTA_BYTES` (default 1 TiB): at ≥80% it `notify`s **warn**
(`storage.quota_warn`), at ≥90% **critical** (`storage.quota_critical`). It also updates a
Prometheus gauge (`provenance_storage_used_bytes` / `_quota_bytes`) on the existing
`/metrics` endpoint. Clock/statfs injected for testing. No-op (logs) when the backend is not
fs. This is the concrete consumer that justified building the notifier first.

### 8. Config (env additions)

`SOCKET_PATH` (optional), `PUBLIC_DIR` (default `./public`), `STORAGE_QUOTA_BYTES` (default
1 TiB), `STORAGE_QUOTA_WARN_PCT` (80), `STORAGE_QUOTA_CRITICAL_PCT` (90). Sidecar-only (not
app env): `PGDUMP_KEEP`, `HEALTHCHECKS_URL`. All added to `packages/server/.env.example`
with the s3/fs split already present, plus a new production `.env` template documented in the
runbook.

### 9. Runbook (`docs/deploy-apphost.md`)

First deploy (rootless-docker setup, `DOCKER_HOST`, git clone, `.env` creation, `systemctl
--user enable/start`, socket permissions), redeploy (`git pull` + `docker compose build` +
`systemctl --user restart`), health check through the socket, restore drill (from a
`pg_dump`), and an **IT coordination checklist**: (a) confirm the app socket path/reachability,
(b) ask whether the Docker data-root/Postgres volume can be on local disk (NFS risk),
(c) ask about a campus SMTP relay for free email alerts, (d) confirm `/home/submit/provenance`
mount + quota.

## Validation (what "deploy-ready" means here)

Much of this can't run in CI (no apphost, no NFS, no systemd). Verifiable now:

- Server code (socket serving, static SPA fallback, quota cron) has Vitest unit tests.
- `docker build` of the image **succeeds locally** (Docker is available) — proves the
  multi-stage build and that the analyzer + server compile and assemble into the image.
- `docker compose -f compose.apphost.yaml config` validates (structural parse).
- The systemd unit + entrypoint are shellcheck-clean / structurally reviewed.
  The actual apphost bring-up is the manual runbook the operator runs over SSH — not something
  this repo can execute. The spec's bar is: every artifact exists, the image builds, code is
  tested, and the runbook is complete and accurate.

## Risks / open coordination items (surfaced in the runbook)

1. **Postgres on NFS** (named volume under NFS home) — recovery guaranteed by nightly
   `pg_dump`; ask IT about local-disk volume storage.
2. **SSH reachability for any future automation** — CI dropped; manual deploy only.
3. **Campus SMTP relay** — would give free email alerts; ask IT. Until then, Discord webhook.
4. **Socket permissions** under rootless Docker + NFS — the app runs as root-in-container and
   chmods the socket world-writable; verify on first deploy that nginx can write it.
