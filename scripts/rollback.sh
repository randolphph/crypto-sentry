#!/usr/bin/env bash
set -Eeuo pipefail

readonly ROOT_DIR="/opt/cryptosentry"
readonly APP_LINK="$ROOT_DIR/app"
readonly SERVICE="cryptosentry.service"
readonly TAG="${1:-}"
readonly RELEASE_DIR="$ROOT_DIR/releases/$TAG"

if [[ $EUID -ne 0 ]]; then
  echo "Run this script with sudo" >&2
  exit 1
fi
if [[ ! "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
  echo "Usage: $0 <previous-version-tag>" >&2
  exit 1
fi
if [[ ! -d "$RELEASE_DIR" ]]; then
  echo "Release is not installed locally: $RELEASE_DIR" >&2
  exit 1
fi

readonly CURRENT_RELEASE="$(readlink -f "$APP_LINK")"
if [[ "$CURRENT_RELEASE" == "$RELEASE_DIR" ]]; then
  echo "CryptoSentry is already running $TAG"
  exit 0
fi

systemctl stop "$SERVICE"
if ! sudo -u cryptosentry "$CURRENT_RELEASE/scripts/backup.sh"; then
  systemctl start "$SERVICE"
  echo "Backup failed; rollback cancelled" >&2
  exit 1
fi

ln -s "$RELEASE_DIR" "$APP_LINK.next"
mv -Tf "$APP_LINK.next" "$APP_LINK"
systemctl start "$SERVICE"

for _ in {1..20}; do
  if curl --fail --silent --show-error --max-time 5 http://127.0.0.1:3000/health >/dev/null; then
    echo "CryptoSentry rolled back successfully: $TAG"
    exit 0
  fi
  sleep 1
done

systemctl stop "$SERVICE"
ln -s "$CURRENT_RELEASE" "$APP_LINK.next"
mv -Tf "$APP_LINK.next" "$APP_LINK"
systemctl start "$SERVICE"
echo "Rollback health check failed; restored $CURRENT_RELEASE" >&2
exit 1
