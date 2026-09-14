#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly ENV_FILE="${CRYPTOSENTRY_ENV_FILE:-/etc/cryptosentry.env}"
readonly BACKUP_DIR="${CRYPTOSENTRY_BACKUP_DIR:-/opt/cryptosentry/backups}"

if [[ ! -r "$ENV_FILE" ]]; then
  echo "Cannot read $ENV_FILE" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

if [[ -z "${DATABASE_PATH:-}" || ! -f "$DATABASE_PATH" ]]; then
  echo "DATABASE_PATH does not point to an existing database" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
readonly TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
readonly TARGET="$BACKUP_DIR/monitor-$TIMESTAMP.sqlite"
readonly TEMP_TARGET="$TARGET.partial"

sqlite3 "$DATABASE_PATH" ".backup '$TEMP_TARGET'"
sqlite3 "$TEMP_TARGET" 'PRAGMA integrity_check;' | grep -qx 'ok'
mv "$TEMP_TARGET" "$TARGET"

backup_index=0
while IFS= read -r backup; do
  ((backup_index += 1))
  if (( backup_index > 7 )); then
    rm -f -- "$backup"
  fi
done < <(ls -1t "$BACKUP_DIR"/monitor-*.sqlite 2>/dev/null || true)

echo "Backup created: $TARGET"
