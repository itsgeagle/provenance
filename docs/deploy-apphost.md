# Deploying Provenance on the EECS apphost

This is the manual runbook for standing up and operating Provenance on the EECS
Instructional apphost (`instapphost.eecs.berkeley.edu`, public URL
`https://provenance.eecs.berkeley.edu`). There is no CI/CD for this deploy —
GitHub's hosted runners can't reach `instapphost`, so every step here is run by
hand over SSH. See `docs/superpowers/specs/2026-07-10-apphost-deployment-design.md`
for the design rationale; this doc is the operational how-to.

Artifacts referenced below live in `deploy/`: `Dockerfile`, `entrypoint.sh`,
`compose.apphost.yaml`, `pg-dump-sidecar.sh`, `provenance.service`, `.env.example`.

## 1. One-time host setup

SSH in as the `provenance` service account:

```sh
ssh -l provenance instapphost.eecs.berkeley.edu
```

Enable rootless Docker (one-time, per the apphost's own setup script):

```sh
inst-dockerd-rootless-setup.sh
```

Point the `docker` CLI at the rootless daemon's socket by adding this to
`~/.bashrc` (then re-source, or start a new shell):

```sh
echo 'export DOCKER_HOST="unix://$XDG_RUNTIME_DIR/docker.sock"' >> ~/.bashrc
source ~/.bashrc
```

Clone the repo:

```sh
git clone https://github.com/itsgeagle/provenance.git ~/provenance
```

Create the deploy env file from the checked-in template and lock it down
(it holds secrets — `deploy/.env` is gitignored, never commit it):

```sh
cp ~/provenance/deploy/.env.example ~/provenance/deploy/.env
chmod 600 ~/provenance/deploy/.env
$EDITOR ~/provenance/deploy/.env
```

Fill in every value in `deploy/.env` — `POSTGRES_PASSWORD`,
`BLOB_URL_SIGNING_SECRET`, `AUTH_COOKIE_SIGNING_SECRET`,
`GOOGLE_OAUTH_CLIENT_ID`/`_SECRET`, `AUTH_SUPERADMIN_EMAILS` — with real
values before the first deploy. Leave `ALERT_EMAIL_RECIPIENTS` and
`HEALTHCHECKS_URL` empty for now (see §6 and the IT coordination checklist
in §5).

Create the directories the compose stack expects on the NFS mount and the
apphost's socket directory (both are bind-mounted into the `app`/`pgdump`
containers by `compose.apphost.yaml`):

```sh
mkdir -p /home/submit/provenance/backups
mkdir -p /srv/appsockets/provenance/main
```

Confirm the 1TB-quota'd mount is present and sized as expected:

```sh
df -h /home/submit/provenance
```

## 2. First deploy

Build the image, passing the current commit SHA as a build arg (baked into
the image, surfaced in the `app.startup` notification and `/healthz`):

```sh
cd ~/provenance/deploy
GIT_SHA=$(git -C .. rev-parse --short HEAD) docker compose -f compose.apphost.yaml build
```

Install the systemd user unit and start the stack:

```sh
mkdir -p ~/.config/systemd/user
cp ~/provenance/deploy/provenance.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now provenance
```

Verify the server came up on the Unix socket (not a TCP port):

```sh
journalctl --user -u provenance -f
```

Look for a log line like `"Server listening (unix socket)"` with
`socket: "/run/sockets/app.sock"`. Then, in another shell, confirm the
socket landed on the host at the expected path and is world-writable (so
the apphost's nginx, running as a different user, can connect to it):

```sh
ls -la /srv/appsockets/provenance/main/app.sock
# expect: srwxrwxrwx ... app.sock
```

Finally, hit the public health check through nginx:

```sh
curl -sf https://provenance.eecs.berkeley.edu/healthz
```

## 3. Redeploy

For every subsequent deploy of a new commit:

```sh
cd ~/provenance
git pull
cd deploy
GIT_SHA=$(git -C .. rev-parse --short HEAD) docker compose -f compose.apphost.yaml build
systemctl --user restart provenance
```

`entrypoint.sh` runs the Drizzle migrator (`dist/db/migrate.js`) before
starting the server on every restart; migrations are idempotent, so this is
safe even if the incoming commit has no new migration. Tail
`journalctl --user -u provenance -f` again to confirm the new `GIT_SHA` shows
up in the startup notification and the socket comes back up.

## 4. Restore drill

Practice this before you need it for real, and re-run it periodically.

Pick a dump to restore from the nightly backups (host path
`/home/submit/provenance/backups/`, which is the same directory the `pgdump`
sidecar sees as `/data/backups/` since both mount `/home/submit/provenance`):

```sh
ls -la /home/submit/provenance/backups/
```

Stop just the `app` service so the database isn't being written to during
the restore, while leaving `postgres`/`pgdump` running:

```sh
cd ~/provenance/deploy
docker compose -f compose.apphost.yaml stop app
```

Create a fresh database and restore into it, using the `pgdump` sidecar
container (it already has both `/data/backups` and network access to
`postgres` via `PGHOST=postgres`). `$POSTGRES_USER` here is the sidecar/
postgres container's own env var (set from `deploy/.env`), so it must expand
inside the container, not your host shell — hence `sh -c '...'`:

```sh
docker compose -f compose.apphost.yaml exec postgres \
  sh -c 'createdb -U "$POSTGRES_USER" provenance_restore_drill'

docker compose -f compose.apphost.yaml exec pgdump \
  sh -c 'pg_restore -h postgres -U "$POSTGRES_USER" -d provenance_restore_drill \
  /data/backups/<the-dump-you-picked>.dump'
```

Spot-check the restored data (row counts on a couple of tables, a recent
submission), then drop the drill database:

```sh
docker compose -f compose.apphost.yaml exec postgres \
  sh -c 'dropdb -U "$POSTGRES_USER" provenance_restore_drill'
```

Restart the app:

```sh
systemctl --user restart provenance
```

## 5. IT coordination checklist

These are open items to raise with EECS Instructional/IT before or shortly
after the first deploy — not blockers to a first deploy, but risks to close
out:

- **(a) Socket path + nginx write access.** Confirm with IT that nginx's
  proxy config for `provenance.eecs.berkeley.edu` points at
  `/srv/appsockets/provenance/main/app.sock`, and that the nginx worker's
  user can write/connect to a socket the app creates world-writable. Verify
  this concretely on first deploy (§2's `ls -la` check and the `healthz`
  curl through the public URL) — don't just take it on faith.
- **(b) Postgres-on-NFS risk.** Rootless Docker's volume store (including the
  `pgdata` named volume `compose.apphost.yaml` uses for Postgres) lives under
  the NFS home directory. Postgres on NFS is a known footgun (locking
  semantics, fsync guarantees). Ask IT whether the rootless Docker data-root,
  or at least this named volume, can be relocated to local disk instead. Until
  resolved, the nightly `pg_dump` (§4) is the recovery guarantee — treat the
  restore drill as load-bearing, not optional.
- **(c) Campus SMTP relay.** Ask IT whether there's a campus SMTP relay we can
  use for outbound mail without standing up our own MTA. If yes, set
  `SMTP_URL`/`SMTP_FROM` and `ALERT_EMAIL_RECIPIENTS` in `deploy/.env` to
  enable the email alert sink. Until then, rely on the Discord webhook sink
  (§6) — it's free and requires no campus coordination.
- **(d) `/home/submit/provenance` mount + quota.** Confirm the mount is
  provisioned with the expected 1TB hard quota (§1's `df -h` check), and ask
  IT what happens at the quota boundary (writes fail vs. get throttled) so the
  `STORAGE_QUOTA_WARN_PCT`/`STORAGE_QUOTA_CRITICAL_PCT` thresholds in
  `packages/server/.env.example` (80% / 90% of `STORAGE_QUOTA_BYTES`) give
  enough lead time.
- **(e) Quota measurement caveat.** The `storage_quota_check` cron measures
  usage via `statfs` on `BLOB_STORAGE_FS_ROOT` (`packages/server/src/services/storage/usage.ts`),
  which reports usage for the whole filesystem/mount `/data` lives on. This is
  correct as long as `/home/submit/provenance` is a dedicated mount for
  Provenance. If the fileserver's quota is enforced server-side in a way that
  `statfs` doesn't reflect, or the mount ever becomes shared with other
  tenants, this measurement will be wrong (silently under- or over-reporting)
  — ask IT how the quota is actually enforced, and if `statfs` doesn't line
  up, swap `measureUsedBytes` for a directory-walk sum or whatever quota API
  the fileserver exposes. The function is injected specifically so this swap
  doesn't touch the cron's control flow.

## 6. Notifications setup

### Discord webhook (`ALERT_WEBHOOK_URL`)

1. In the target Discord server, open **Server Settings → Integrations →
   Webhooks → New Webhook**.
2. Name it (e.g. "Provenance Alerts") and pick the channel it should post to.
3. Click **Copy Webhook URL**.
4. Set it in `deploy/.env`:

   ```sh
   ALERT_WEBHOOK_URL=https://discord.com/api/webhooks/<id>/<token>
   ```

5. Restart the app (`systemctl --user restart provenance`) to pick it up.
   `ALERT_WEBHOOK_MIN_SEVERITY` (default `warn`) controls which severities get
   forwarded; `storage.quota_warn`/`storage.quota_critical` from the quota
   cron (§5d) will show up here once usage crosses 80%/90%.

### healthchecks.io dead-man's-switch (`HEALTHCHECKS_URL`)

The `pgdump` sidecar (`deploy/pg-dump-sidecar.sh`) pings this URL after every
successful nightly `pg_dump`, and a `/fail`-suffixed variant on failure — a
silently-broken backup job is otherwise invisible until you need a restore
and there isn't one.

1. Sign up for a free account at <https://healthchecks.io>.
2. Create a new check (e.g. "provenance-pg-dump"), period **1 day** plus a
   grace period of a few hours (the dump runs on a `sleep 86400` loop, not a
   precise cron).
3. Copy the check's ping URL (`https://hc-ping.com/<uuid>`).
4. Set it in `deploy/.env`:

   ```sh
   HEALTHCHECKS_URL=https://hc-ping.com/<uuid>
   ```

5. Restart the stack (`systemctl --user restart provenance`, or just
   `docker compose -f compose.apphost.yaml up -d pgdump` to restart only the
   sidecar). healthchecks.io will alert you (email, or its own integrations)
   if a ping doesn't arrive within the period + grace window.
