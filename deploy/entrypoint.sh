#!/bin/sh
set -eu

# Mode-aware entrypoint. The compose stack runs three flavours off this one
# image (see deploy/compose.apphost.yaml):
#
#   migrate               -> `entrypoint.sh migrate`      (one-shot, exits 0)
#   api    (app service)  -> `entrypoint.sh --mode=api`
#   worker                -> `entrypoint.sh --mode=worker` (scaled to N replicas)
#
# Migrations run ONLY in the one-shot `migrate` service, which api/worker
# depend on (condition: service_completed_successfully). They must not run in
# api/worker containers -- with multiple worker replicas that would race.

if [ "${1:-}" = "migrate" ]; then
  echo "[entrypoint] running migrations..."
  exec node /app/packages/server/dist/db/migrate.js
fi

echo "[entrypoint] starting server ($*)..."
exec node /app/packages/server/dist/index.js "$@"
