#!/usr/bin/env bash
# Starts secval. When the Backblaze settings are present, the store is first
# restored from the backup (if this machine has none), then secval runs under
# Litestream, which keeps the backup current. Without them, secval runs as is.
set -eu
export SECVAL_DB_PATH="${DATA_DIR:-$PWD/data}/secval.sqlite"
mkdir -p "$(dirname "$SECVAL_DB_PATH")"

if [ -n "${LITESTREAM_BUCKET:-}" ] && [ -x ./bin/litestream ]; then
  # e.g. s3.eu-central-003.backblazeb2.com -> eu-central-003
  export LITESTREAM_REGION="${LITESTREAM_REGION:-$(echo "${LITESTREAM_ENDPOINT:-}" | sed -E 's#^(https?://)?s3\.([^.]+)\..*#\2#')}"
  if ./bin/litestream restore -config litestream.yml -if-db-not-exists -if-replica-exists "$SECVAL_DB_PATH"; then
    export SECVAL_BACKUP_MODE=on
    exec ./bin/litestream replicate -config litestream.yml -exec "npx tsx server/index.ts"
  fi
  # Restore failed (e.g. Backblaze unreachable). Run without backing up, so an
  # empty store never overwrites the good backup.
  echo "secval: WARNING could not restore backup; running without it this time"
  export SECVAL_BACKUP_MODE=restore-failed
  exec npx tsx server/index.ts
fi

echo "secval: no backup configured; data resets when the free tier sleeps"
export SECVAL_BACKUP_MODE=off
exec npx tsx server/index.ts
