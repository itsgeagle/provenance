# EECS Apphost Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make Provenance deployable on the EECS apphost: Unix-socket serving, same-origin SPA serving, a multi-stage image, a compose stack (app + self-hosted Postgres + pg_dump sidecar), a systemd user unit, a quota-check cron wired to the notifier, and a complete deploy runbook.

**Architecture:** The server listens on a world-writable Unix socket that IT's nginx proxies to (TLS at the edge). It serves the built analyzer SPA from the same origin as `/api/v1`. One image runs `--mode=all`. Postgres is a self-hosted container (named volume, NFS-risk mitigated by nightly `pg_dump`). A quota cron watches the 1TB mount and pushes alerts through the notifier. Deploy is manual on the host (no CI).

**Tech Stack:** TS strict ESM, `@hono/node-server` (`getRequestListener`), `node:http`, `node:fs`, Vitest; Docker multi-stage (`node:22`, `postgres:16`), docker compose, systemd user unit. **Depends on the operational-notifications feature** (same branch, built first).

## Global Constraints

- Scope: `packages/server/**` (runtime code) + repo-root/`deploy/` artifacts + `docs/`. No other workspace source.
- No new npm dependencies. Node built-ins + existing libs only.
- TypeScript strict; no `any` except at an FFI boundary with a comment.
- Socket serving must remain backward-compatible: unset `SOCKET_PATH` → existing TCP `PORT` behavior unchanged (dev/tests).
- The socket file must be **world-writable** after listen (nginx writes it) and any stale socket removed before bind.
- SPA serving must not shadow `/api/v1/*` or `/healthz` or `/metrics`.
- Quota cron: injected clock + injected usage-measure; no `Date.now()`/real `statfs` in assertions.
- The image **runs as root** (required to write the NFS bind mount per apphost model) — documented inline in the Dockerfile.
- Commit after each task: `git commit --no-gpg-sign`, conventional prefix, no `Co-Authored-By`.
- Verify: `npm run typecheck/lint/test --workspace=packages/server`; for infra tasks, `docker build` and `docker compose -f deploy/compose.apphost.yaml config`.

## File Structure

**Create:** `deploy/Dockerfile`, `deploy/entrypoint.sh`, `deploy/compose.apphost.yaml`, `deploy/pg-dump-sidecar.sh`, `deploy/provenance.service`, `deploy/.dockerignore`, `docs/deploy-apphost.md`; `packages/server/src/api/listen.ts` (+test), `packages/server/src/api/static.ts` (+test), `packages/server/src/jobs/storage-quota-check.ts` (+test), `packages/server/src/services/storage/usage.ts` (+test).
**Modify:** `packages/server/src/config/env.ts`, `packages/server/src/api/start.ts`, `packages/server/src/jobs/pg-boss.ts`, `packages/server/src/jobs/worker.ts`, `packages/server/.env.example`.

---

## Task 1: Config — deployment env vars

**Files:** Modify `config/env.ts`; Test `config/env.test.ts`.

**Produces (on `Env`):** `SOCKET_PATH?: string`, `PUBLIC_DIR: string` (default `./public`), `STORAGE_QUOTA_BYTES: number` (default `1099511627776` = 1 TiB), `STORAGE_QUOTA_WARN_PCT: number` (80), `STORAGE_QUOTA_CRITICAL_PCT: number` (90).

- [ ] **Step 1: Failing test** — assert defaults and that `SOCKET_PATH` is optional/undefined by default, `PUBLIC_DIR` defaults to `./public`, quota defaults correct.
- [ ] **Step 2: Verify red.**
- [ ] **Step 3: Implement** — add to `rawEnvSchema`:

```ts
  SOCKET_PATH: z.string().optional(),
  PUBLIC_DIR: z.string().min(1).default('./public'),
  STORAGE_QUOTA_BYTES: intStr(1099511627776),
  STORAGE_QUOTA_WARN_PCT: intStr(80),
  STORAGE_QUOTA_CRITICAL_PCT: intStr(90),
```

- [ ] **Step 4: Verify green; typecheck; lint. Step 5: Commit** — `feat(server): deployment/socket/quota config env vars`.

---

## Task 2: Unix-socket serving

**Files:** Create `api/listen.ts` + `api/listen.test.ts`; Modify `api/start.ts`.

**Produces:** `interface ListenTarget { kind: 'socket'; path: string } | { kind: 'tcp'; port: number }`; `function resolveListenTarget(cfg: Pick<Env,'SOCKET_PATH'|'PORT'>): ListenTarget`; `function prepareSocket(path: string, fs?: {existsSync,unlinkSync}): void` (removes a stale socket file if present); `function makeWorldWritable(path: string, fs?: {chmodSync}): void` (chmod 0o777). `startApi()` uses `getRequestListener(app.fetch)` + `node:http.createServer` and listens on the resolved target.

- [ ] **Step 1: Failing tests** (`listen.test.ts`, injected fs stubs):

```ts
it('prefers socket when SOCKET_PATH set', () => {
  expect(resolveListenTarget({ SOCKET_PATH: '/run/app.sock', PORT: 3000 }))
    .toEqual({ kind: 'socket', path: '/run/app.sock' });
});
it('falls back to tcp port when SOCKET_PATH unset', () => {
  expect(resolveListenTarget({ SOCKET_PATH: undefined, PORT: 3000 }))
    .toEqual({ kind: 'tcp', port: 3000 });
});
it('prepareSocket unlinks an existing socket file', () => {
  const unlinked: string[] = [];
  prepareSocket('/run/app.sock', { existsSync: () => true, unlinkSync: (p: string) => unlinked.push(p) } as any);
  expect(unlinked).toEqual(['/run/app.sock']);
});
it('prepareSocket is a no-op when no file exists', () => {
  const unlinked: string[] = [];
  prepareSocket('/run/app.sock', { existsSync: () => false, unlinkSync: (p: string) => unlinked.push(p) } as any);
  expect(unlinked).toEqual([]);
});
it('makeWorldWritable chmods 0o777', () => {
  const calls: Array<[string, number]> = [];
  makeWorldWritable('/run/app.sock', { chmodSync: (p: string, m: number) => calls.push([p, m]) } as any);
  expect(calls).toEqual([['/run/app.sock', 0o777]]);
});
```

- [ ] **Step 2: Verify red.**
- [ ] **Step 3: Implement `listen.ts`** (pure helpers with default `node:fs` bindings).
- [ ] **Step 4: Rewire `start.ts` `startApi()`:**

```ts
import { getRequestListener } from '@hono/node-server';
import { createServer } from 'node:http';
import { resolveListenTarget, prepareSocket, makeWorldWritable } from './listen.js';

export function startApi(): void {
  const cfg = getConfig();
  const logger = getLogger();
  const app = createApp();
  const server = createServer(getRequestListener(app.fetch));
  const target = resolveListenTarget(cfg);
  if (target.kind === 'socket') {
    prepareSocket(target.path);
    server.listen(target.path, () => {
      makeWorldWritable(target.path);
      logger.info({ socket: target.path }, 'Server listening (unix socket)');
    });
  } else {
    server.listen(target.port, () => logger.info({ port: target.port }, 'Server listening (tcp)'));
  }
}
```

Keep `createApp()` unchanged. Confirm `getRequestListener` is exported by the installed `@hono/node-server` (it is in current versions); if not, use `serve({ fetch, ... })` for TCP and only use the `createServer` path for sockets.

- [ ] **Step 5: Verify** — `npm run test --workspace=packages/server -- src/api/listen.test.ts`; typecheck; lint. Also run `src/api/start.test.ts` to confirm `createApp`/healthz unaffected. **Commit** — `feat(server): listen on a world-writable unix socket when SOCKET_PATH is set`.

---

## Task 3: Same-origin SPA serving

**Files:** Create `api/static.ts` + `api/static.test.ts`; Modify `api/start.ts` (`createApp`).

**Produces:** `function mountStatic(app: Hono, opts: { publicDir: string }): void` — serves files from `publicDir` and SPA-falls-back to `index.html`, mounted so it never intercepts `/api`, `/healthz`, `/metrics`.

- [ ] **Step 1: Failing test** (`static.test.ts`) — write a temp `publicDir` with `index.html` (`<html>APP</html>`) and `assets/app.js`; build an app via `createApp()` (or a minimal Hono with `mountStatic`); assert: `GET /` → 200 containing `APP`; `GET /assets/app.js` → 200; `GET /some/client/route` → 200 `index.html` (SPA fallback); `GET /api/v1/anything` and `GET /healthz` are NOT the SPA (still routed to API/health). Use `app.fetch(new Request('http://x/...'))`.
- [ ] **Step 2: Verify red.**
- [ ] **Step 3: Implement `static.ts`** using `@hono/node-server`'s `serveStatic` (already a dep) with `root: publicDir` and an `onNotFound`/rewrite that serves `index.html` for non-asset paths. Guard so it only mounts for non-`/api`/`/healthz`/`/metrics` paths (register it LAST in `createApp`, after `app.route('/api/v1', ...)`, and skip when the path starts with those prefixes).
- [ ] **Step 4: Wire `createApp()`** — at the end (after the `/api/v1` mount), `mountStatic(app, { publicDir: getConfig().PUBLIC_DIR })`. Ensure the `/healthz`, `/metrics`, `/api/v1` routes still win (they're registered earlier; Hono matches in order).
- [ ] **Step 5: Verify green; typecheck; lint. Commit** — `feat(server): serve the analyzer SPA from the same origin`.

---

## Task 4: Storage quota-check cron

**Files:** Create `services/storage/usage.ts` (+test), `jobs/storage-quota-check.ts` (+test); Modify `jobs/pg-boss.ts`, `jobs/worker.ts`, `api/middleware/metrics.ts` (gauge).

**Produces:**
- `usage.ts`: `async function measureUsedBytes(root: string): Promise<number>` (default: `node:fs/promises` `statfs` → `(blocks - bavail) * bsize`; documented caveat that this is filesystem-level, to be swapped for a dir/quota measure if the fileserver quota isn't reflected). Kept injectable.
- `storage-quota-check.ts`: `async function runStorageQuotaCheck(deps: { root: string; quotaBytes: number; warnPct: number; criticalPct: number; measure: (root: string) => Promise<number>; notifier: Notifier; setGauge: (used: number, quota: number) => void }): Promise<{ usedBytes: number; pct: number }>` — computes pct, sets the gauge, and notifies `storage.quota_critical` (≥crit) or `storage.quota_warn` (≥warn) with a stable `dedupeKey` per level. `createStorageQuotaCheckHandler(...)` pg-boss factory (no-op unless backend is fs).
- `pg-boss.ts`: `JOB_KINDS.STORAGE_QUOTA_CHECK = 'storage_quota_check'`.
- `metrics.ts`: a Prometheus gauge pair `provenance_storage_used_bytes` / `provenance_storage_quota_bytes`, with a `setStorageGauge(used, quota)` export.

- [ ] **Step 1: Failing test** (`storage-quota-check.test.ts`) — fake `measure` returns fixed bytes, fake `notifier` records, `setGauge` spy:
  - used = 85% of quota → one `warn`/`storage.quota_warn`, gauge set.
  - used = 95% → one `critical`/`storage.quota_critical`.
  - used = 50% → zero notifications, gauge still set.
- [ ] **Step 2: Verify red.**
- [ ] **Step 3: Implement** `usage.ts` + `storage-quota-check.ts` + the metrics gauge + the job kind.
- [ ] **Step 4: Wire `worker.ts`** — `createQueue(STORAGE_QUOTA_CHECK)`, `boss.work(...)` with `createStorageQuotaCheckHandler({ root: cfg.BLOB_STORAGE_FS_ROOT ?? '', quotaBytes: cfg.STORAGE_QUOTA_BYTES, warnPct: cfg.STORAGE_QUOTA_WARN_PCT, criticalPct: cfg.STORAGE_QUOTA_CRITICAL_PCT, notifier: getNotifier(), ... })`, and `boss.schedule(STORAGE_QUOTA_CHECK, '0 * * * *', {})` (hourly). No-op path when backend ≠ fs.
- [ ] **Step 5: Verify green; typecheck; lint. Commit** — `feat(server): hourly storage-quota check with notifier alerts + prom gauge`.

---

## Task 5: Multi-stage Dockerfile + entrypoint

**Files:** Create `deploy/Dockerfile`, `deploy/entrypoint.sh`, `deploy/.dockerignore`.

- [ ] **Step 1: Write `deploy/.dockerignore`:**

```
**/node_modules
**/dist
.git
.superpowers
*.md
docs
```

- [ ] **Step 2: Write `deploy/Dockerfile`** (multi-stage; build from repo root as context):

```dockerfile
# syntax=docker/dockerfile:1
# Build stage — install workspace deps once, build analyzer + server.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages
RUN npm ci
# Build analyzer SPA (produces packages/analyzer/dist)
RUN npm run build --workspace=packages/analyzer
# Build server bundle (produces packages/server/dist/index.js + migrate.js)
RUN npm run build --workspace=packages/server
# Also build the migrate entrypoint if the server build doesn't include it:
RUN npx esbuild packages/server/src/db/migrate.ts --bundle --platform=node --format=esm \
    --outfile=packages/server/dist/db/migrate.js --packages=external

# Runtime stage
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ARG GIT_SHA=unknown
ENV GIT_SHA=$GIT_SHA
# Runs as root: required to write the NFS bind mount on the apphost
# (rootless Docker maps container-root → the host account that owns the mount).
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/server/package.json ./packages/server/package.json
COPY --from=build /app/packages/server/dist ./packages/server/dist
COPY --from=build /app/packages/server/db ./packages/server/db
# Analyzer static build served from PUBLIC_DIR
COPY --from=build /app/packages/analyzer/dist ./packages/server/public
ENV PUBLIC_DIR=/app/packages/server/public
COPY deploy/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh
WORKDIR /app/packages/server
ENTRYPOINT ["/app/entrypoint.sh"]
```

(Implementer: verify the actual server build output paths — `packages/server/dist/index.js`, and that migrations live at `packages/server/db/migrations`. Adjust COPY paths to match reality; the goal is: server bundle + migrations + analyzer dist + entrypoint present in the runtime image. If `--packages=external`, node_modules must be copied as above; confirm the server bundle's runtime imports resolve.)

- [ ] **Step 3: Write `deploy/entrypoint.sh`:**

```sh
#!/bin/sh
set -eu
echo "[entrypoint] running migrations…"
node /app/packages/server/dist/db/migrate.js
echo "[entrypoint] starting server (--mode=all)…"
exec node /app/packages/server/dist/index.js --mode=all
```

- [ ] **Step 4: Validate the build** — from repo root:
  `docker build -f deploy/Dockerfile --build-arg GIT_SHA=$(git rev-parse --short HEAD) -t provenance:local .`
  Expected: build SUCCEEDS. If a COPY path is wrong, fix it and rebuild. Record the final image size and that it built.
- [ ] **Step 5: Commit** — `feat(deploy): multi-stage Dockerfile + entrypoint (analyzer + server, migrate-on-start)`.

---

## Task 6: Compose stack + pg_dump sidecar + systemd unit

**Files:** Create `deploy/compose.apphost.yaml`, `deploy/pg-dump-sidecar.sh`, `deploy/provenance.service`.

- [ ] **Step 1: Write `deploy/pg-dump-sidecar.sh`** (nightly loop; compress; rotate; healthcheck ping):

```sh
#!/bin/sh
set -eu
: "${PGHOST:?}"; : "${PGUSER:?}"; : "${PGDATABASE:?}"; : "${BACKUP_DIR:?}"
KEEP="${PGDUMP_KEEP:-7}"
HC_URL="${HEALTHCHECKS_URL:-}"
while true; do
  TS=$(date -u +%Y%m%dT%H%M%SZ)
  OUT="$BACKUP_DIR/provenance-$TS.dump"
  echo "[pg-dump] $TS → $OUT"
  if pg_dump -Fc -h "$PGHOST" -U "$PGUSER" "$PGDATABASE" > "$OUT.tmp" && mv "$OUT.tmp" "$OUT"; then
    ls -1t "$BACKUP_DIR"/provenance-*.dump | tail -n +$((KEEP + 1)) | xargs -r rm -f
    [ -n "$HC_URL" ] && wget -q -O /dev/null "$HC_URL" || true
  else
    rm -f "$OUT.tmp"
    [ -n "$HC_URL" ] && wget -q -O /dev/null "$HC_URL/fail" || true
  fi
  sleep 86400
done
```

- [ ] **Step 2: Write `deploy/compose.apphost.yaml`:**

```yaml
services:
  app:
    build:
      context: ..
      dockerfile: deploy/Dockerfile
      args:
        GIT_SHA: ${GIT_SHA:-unknown}
    env_file: .env
    environment:
      SOCKET_PATH: /run/sockets/app.sock
      BLOB_STORAGE_FS_ROOT: /data
    volumes:
      - /home/submit/provenance:/data
      - /srv/appsockets/provenance/main:/run/sockets
    depends_on:
      postgres:
        condition: service_healthy
    restart: unless-stopped
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
    ports:
      - "127.0.0.1:${POSTGRES_PORT:-5433}:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER}"]
      interval: 10s
      timeout: 5s
      retries: 5
    restart: unless-stopped
  pgdump:
    image: postgres:16
    entrypoint: ["/bin/sh", "/pg-dump-sidecar.sh"]
    environment:
      PGHOST: postgres
      PGUSER: ${POSTGRES_USER}
      PGPASSWORD: ${POSTGRES_PASSWORD}
      PGDATABASE: ${POSTGRES_DB}
      BACKUP_DIR: /data/backups
      PGDUMP_KEEP: ${PGDUMP_KEEP:-7}
      HEALTHCHECKS_URL: ${HEALTHCHECKS_URL:-}
    volumes:
      - ./pg-dump-sidecar.sh:/pg-dump-sidecar.sh:ro
      - /home/submit/provenance:/data
    depends_on:
      postgres:
        condition: service_healthy
    restart: unless-stopped
volumes:
  pgdata:
```

(Note: `DATABASE_URL` in `.env` must point at `postgres:5432` — the compose service name — not localhost.)

- [ ] **Step 3: Write `deploy/provenance.service`** (systemd user unit):

```ini
[Unit]
Description=Provenance apphost stack (docker compose)
ConditionPathExists=/etc/is-instapphost
After=docker.service
Requires=docker.service

[Service]
Type=simple
Restart=always
WorkingDirectory=%h/provenance/deploy
ExecStartPre=-/bin/rm -f /srv/appsockets/provenance/main/app.sock
ExecStartPre=-/usr/bin/docker compose -f compose.apphost.yaml down
ExecStart=/usr/bin/docker compose -f compose.apphost.yaml up
ExecStop=/usr/bin/docker compose -f compose.apphost.yaml down

[Install]
WantedBy=default.target
```

- [ ] **Step 4: Validate** — `docker compose -f deploy/compose.apphost.yaml config >/dev/null` (needs the referenced env vars present; run with a throwaway `deploy/.env` containing `POSTGRES_USER/PASSWORD/DB` etc., or `--env-file`). Expected: config parses with no error. `shellcheck deploy/pg-dump-sidecar.sh deploy/entrypoint.sh` if available (or eyeball for `set -eu` correctness).
- [ ] **Step 5: Commit** — `feat(deploy): apphost compose stack, pg_dump sidecar, systemd unit`.

---

## Task 7: `.env.example` + deploy runbook

**Files:** Modify `packages/server/.env.example`; Create `docs/deploy-apphost.md`, `deploy/.env.example`.

- [ ] **Step 1: Add to `packages/server/.env.example`** the new vars (grouped): `SOCKET_PATH` (commented, prod-only), `PUBLIC_DIR`, `STORAGE_QUOTA_BYTES`/`_WARN_PCT`/`_CRITICAL_PCT`, `ALERT_WEBHOOK_URL`/`ALERT_EMAIL_RECIPIENTS`/`ALERT_*` (from the notifications feature), `GIT_SHA` (build-set). Each with a one-line comment.
- [ ] **Step 2: Create `deploy/.env.example`** (compose-level, host `.env` template): `POSTGRES_USER/PASSWORD/DB/PORT`, `DATABASE_URL=postgres://…@postgres:5432/…`, `PUBLIC_BASE_URL=https://provenance.eecs.berkeley.edu`, `BLOB_STORAGE_BACKEND=fs`, `BLOB_URL_SIGNING_SECRET=…`, `AUTH_*`, `GOOGLE_OAUTH_*`, `ALERT_WEBHOOK_URL=…`, `HEALTHCHECKS_URL=…`, `PGDUMP_KEEP=7`, `GIT_SHA=…` — with placeholders and comments.
- [ ] **Step 3: Write `docs/deploy-apphost.md`** covering, in order:
  1. **One-time host setup:** `ssh -l provenance instapphost…`; `inst-dockerd-rootless-setup.sh`; add `DOCKER_HOST="unix://$XDG_RUNTIME_DIR/docker.sock"` to `.bashrc`; `git clone` the repo to `~/provenance`; create `deploy/.env` (chmod 600) from the template; create `/home/submit/provenance/backups` and confirm the mount + quota; ensure `/srv/appsockets/provenance/main` exists.
  2. **First deploy:** `cd ~/provenance/deploy && GIT_SHA=$(git -C .. rev-parse --short HEAD) docker compose -f compose.apphost.yaml build`; install the systemd unit (`cp deploy/provenance.service ~/.config/systemd/user/`); `systemctl --user enable --now provenance`; verify `journalctl --user -u provenance` shows "Server listening (unix socket)" and the socket is world-writable; hit `https://provenance.eecs.berkeley.edu/healthz`.
  3. **Redeploy:** `git pull && docker compose -f compose.apphost.yaml build && systemctl --user restart provenance`.
  4. **Restore drill:** stop app; `pg_restore` a chosen `/data/backups/*.dump` into a fresh DB; restart.
  5. **IT coordination checklist:** (a) confirm the app socket path + that nginx can write it; (b) **ask whether the rootless Docker data-root / Postgres volume can live on local disk** (Postgres-on-NFS risk); (c) ask about a **campus SMTP relay** for free email alerts (then set `ALERT_EMAIL_RECIPIENTS` + `SMTP_URL`); (d) confirm the `/home/submit/provenance` mount + 1TB quota; (e) note `statfs`-based quota measurement may need swapping for the fileserver's quota API if usage isn't reflected.
  6. **Notifications:** how to create the Discord incoming webhook and set `ALERT_WEBHOOK_URL`; healthchecks.io setup for `HEALTHCHECKS_URL`.
- [ ] **Step 4: Verify** — `docs/deploy-apphost.md` has no placeholder/TBD; commands are copy-pasteable and consistent with the compose/systemd files (paths, service names, socket path). Prettier check on the markdown.
- [ ] **Step 5: Commit** — `docs(deploy): apphost deploy runbook + env templates`.

---

## Self-Review Checklist (after writing all tasks)

- Socket path, storage mount path, service names, and env var names are identical across the Dockerfile, compose, systemd unit, runbook, and code (`SOCKET_PATH=/run/sockets/app.sock`, `/home/submit/provenance:/data`, `BLOB_STORAGE_FS_ROOT=/data`, postgres service `postgres:5432`).
- SPA serving registered AFTER `/api/v1` + `/healthz` + `/metrics` so they win.
- Quota cron no-ops for non-fs backends; clock + measure injected.
- Dockerfile COPY paths match the real server build output (verified by the actual `docker build`).
- Runbook surfaces every open coordination item from the spec (NFS-Postgres, SMTP relay, socket perms, quota measurement caveat).
- Nothing here silently assumes CI — deploy is manual, documented.
