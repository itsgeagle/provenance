#!/bin/sh
set -eu
echo "[entrypoint] running migrations..."
node /app/packages/server/dist/db/migrate.js
echo "[entrypoint] starting server (--mode=all)..."
exec node /app/packages/server/dist/index.js --mode=all
