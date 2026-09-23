#!/usr/bin/env bash
set -Eeuo pipefail

readonly ROOT_DIR="/opt/cryptosentry"
readonly APP_LINK="$ROOT_DIR/app"
readonly RELEASES_DIR="$ROOT_DIR/releases"
readonly ENV_FILE="/etc/cryptosentry.env"
readonly SERVICE="cryptosentry.service"
readonly TAG="${1:-}"

if [[ $EUID -ne 0 ]]; then
  echo "Run this script with sudo" >&2
  exit 1
fi
if [[ ! "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
  echo "Usage: $0 <explicit-version-tag>, for example v0.1.0" >&2
  exit 1
fi
if [[ ! -L "$APP_LINK" && ! -d "$APP_LINK/.git" ]]; then
  echo "$APP_LINK is not an installed CryptoSentry checkout" >&2
  exit 1
fi

readonly CURRENT_RELEASE="$(readlink -f "$APP_LINK")"
REPOSITORY_URL="$(sudo -u cryptosentry git -C "$CURRENT_RELEASE" remote get-url origin)"
readonly REPOSITORY_URL
readonly RELEASE_DIR="$RELEASES_DIR/$TAG"

git ls-remote --exit-code --tags "$REPOSITORY_URL" "refs/tags/$TAG" >/dev/null
if [[ -e "$RELEASE_DIR" ]]; then
  echo "Release directory already exists: $RELEASE_DIR" >&2
  exit 1
fi

mkdir -p "$RELEASES_DIR"
git clone --quiet --depth 1 --branch "$TAG" "$REPOSITORY_URL" "$RELEASE_DIR"
chown -R cryptosentry:cryptosentry "$RELEASE_DIR"

sudo -u cryptosentry npm --prefix "$RELEASE_DIR" ci
sudo -u cryptosentry npm --prefix "$RELEASE_DIR" test
sudo -u cryptosentry npm --prefix "$RELEASE_DIR" run build

systemctl stop "$SERVICE"
if ! sudo -u cryptosentry "$CURRENT_RELEASE/scripts/backup.sh"; then
  systemctl start "$SERVICE"
  echo "Backup failed; the existing release was restarted" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
sudo -u cryptosentry --preserve-env=DATABASE_PATH,API_TOKEN,MASTER_ENCRYPTION_KEY npm --prefix "$RELEASE_DIR" run db:migrate

ln -s "$RELEASE_DIR" "$APP_LINK.next"
mv -Tf "$APP_LINK.next" "$APP_LINK"
systemctl start "$SERVICE"

health_ok=false
for _ in {1..20}; do
  if curl --fail --silent --show-error --max-time 5 http://127.0.0.1:3000/health >/dev/null && \
     curl --fail --silent --show-error --max-time 5 -H "Authorization: Bearer $API_TOKEN" http://127.0.0.1:3000/api/v1/status/summary >/dev/null; then
    health_ok=true
    break
  fi
  sleep 1
done

if [[ "$health_ok" != true ]]; then
  systemctl stop "$SERVICE"
  ln -s "$CURRENT_RELEASE" "$APP_LINK.next"
  mv -Tf "$APP_LINK.next" "$APP_LINK"
  systemctl start "$SERVICE"
  journalctl -u "$SERVICE" -n 100 --no-pager >&2
  echo "Health check failed; rolled back to $CURRENT_RELEASE" >&2
  exit 1
fi

echo "CryptoSentry deployed successfully: $TAG"
