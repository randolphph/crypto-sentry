#!/usr/bin/env bash
set -Eeuo pipefail
umask 027

readonly REPOSITORY_URL="${1:-}"
readonly TAG="${2:-}"
readonly DOMAIN="${3:-}"
readonly ROOT_DIR="/opt/cryptosentry"

if [[ $EUID -ne 0 ]]; then
  echo "Run this script with sudo" >&2
  exit 1
fi
if [[ -z "$REPOSITORY_URL" || ! "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ || -z "$DOMAIN" ]]; then
  echo "Usage: $0 <git-repository-url> <version-tag> <monitor-domain>" >&2
  exit 1
fi

apt-get update
apt-get install -y ca-certificates curl git sqlite3 sudo gnupg openssl debian-keyring debian-archive-keyring apt-transport-https
curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/cryptosentry-nodesource.sh
bash /tmp/cryptosentry-nodesource.sh
apt-get install -y nodejs
npm install --global pnpm@10.15.1

if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' -o /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
fi

id -u cryptosentry >/dev/null 2>&1 || useradd --system --home-dir "$ROOT_DIR" --shell /usr/sbin/nologin cryptosentry
install -d -o cryptosentry -g cryptosentry -m 0750 "$ROOT_DIR" "$ROOT_DIR/releases" "$ROOT_DIR/data" "$ROOT_DIR/backups"

readonly RELEASE_DIR="$ROOT_DIR/releases/$TAG"
git clone --depth 1 --branch "$TAG" "$REPOSITORY_URL" "$RELEASE_DIR"
chown -R cryptosentry:cryptosentry "$RELEASE_DIR"
sudo -u cryptosentry pnpm --dir "$RELEASE_DIR" install --frozen-lockfile
sudo -u cryptosentry pnpm --dir "$RELEASE_DIR" test
sudo -u cryptosentry pnpm --dir "$RELEASE_DIR" build
ln -s "$RELEASE_DIR" "$ROOT_DIR/app"

if [[ ! -e /etc/cryptosentry.env ]]; then
  API_TOKEN_VALUE="$(openssl rand -hex 32)"
  MASTER_KEY_VALUE="$(openssl rand -base64 32)"
  install -o root -g cryptosentry -m 0640 /dev/null /etc/cryptosentry.env
  {
    echo 'DATABASE_PATH=/opt/cryptosentry/data/monitor.sqlite'
    echo "API_TOKEN=$API_TOKEN_VALUE"
    echo "MASTER_ENCRYPTION_KEY=$MASTER_KEY_VALUE"
  } >/etc/cryptosentry.env
fi

readonly NODE_PATH_VALUE="$(command -v node)"
sed "s|__NODE_PATH__|$NODE_PATH_VALUE|" "$RELEASE_DIR/deploy/cryptosentry.service" >/etc/systemd/system/cryptosentry.service
install -m 0644 "$RELEASE_DIR/deploy/cryptosentry-backup.service" /etc/systemd/system/cryptosentry-backup.service
install -m 0644 "$RELEASE_DIR/deploy/cryptosentry-backup.timer" /etc/systemd/system/cryptosentry-backup.timer
sed "s|monitor.example.com|$DOMAIN|" "$RELEASE_DIR/deploy/Caddyfile.example" >/etc/caddy/Caddyfile

set -a
# shellcheck disable=SC1091
source /etc/cryptosentry.env
set +a
sudo -u cryptosentry --preserve-env=DATABASE_PATH,API_TOKEN,MASTER_ENCRYPTION_KEY pnpm --dir "$RELEASE_DIR" db:migrate

systemctl daemon-reload
systemctl enable --now cryptosentry.service cryptosentry-backup.timer caddy.service
curl --fail --silent --show-error --max-time 5 http://127.0.0.1:3000/health >/dev/null

echo "CryptoSentry installed. Store /etc/cryptosentry.env securely; its secrets are not printed."
