#!/bin/sh
set -eu
: "${PGHOST:?}"; : "${PGUSER:?}"; : "${PGDATABASE:?}"; : "${BACKUP_DIR:?}"
KEEP="${PGDUMP_KEEP:-7}"
HC_URL="${HEALTHCHECKS_URL:-}"
mkdir -p "$BACKUP_DIR"
while true; do
  TS=$(date -u +%Y%m%dT%H%M%SZ)
  OUT="$BACKUP_DIR/provenance-$TS.dump"
  echo "[pg-dump] $TS -> $OUT"
  if pg_dump -Fc -h "$PGHOST" -U "$PGUSER" "$PGDATABASE" > "$OUT.tmp" && mv "$OUT.tmp" "$OUT"; then
    ls -1t "$BACKUP_DIR"/provenance-*.dump | tail -n +$((KEEP + 1)) | xargs -r rm -f
    [ -n "$HC_URL" ] && wget -q -O /dev/null "$HC_URL" || true
  else
    rm -f "$OUT.tmp"
    [ -n "$HC_URL" ] && wget -q -O /dev/null "$HC_URL/fail" || true
  fi
  sleep 86400
done
