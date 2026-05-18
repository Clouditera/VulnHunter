#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

WEB_PORT="${WEB_PORT:-23000}"
DATA_DIR_DEFAULT="/opt/vulnhunt/data"

rand_hex() { openssl rand -hex "$1"; }
require_cmd() { command -v "$1" >/dev/null 2>&1 || { echo "[install] missing command: $1" >&2; exit 1; }; }

require_cmd docker
require_cmd openssl
require_cmd curl
if ! docker compose version >/dev/null 2>&1; then
  echo "[install] Docker Compose v2 is required" >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "[install] Docker daemon is not reachable" >&2
  exit 1
fi

arch="$(uname -m)"
if [[ "$arch" != "x86_64" && "$arch" != "amd64" ]]; then
  echo "[install] unsupported architecture: $arch (x86_64 required)" >&2
  exit 1
fi

mem_kb="$(awk '/MemTotal/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)"
if (( mem_kb > 0 && mem_kb < 32*1024*1024 )); then
  echo "[install] warning: memory below recommended 32GiB; install smoke can run, large scans may need lower concurrency" >&2
fi

if [[ ! -f .env ]]; then
  cp .env.example .env
  data_dir="${DATA_DIR:-$DATA_DIR_DEFAULT}"
  sed -i "s|^DATA_DIR=.*|DATA_DIR=$data_dir|" .env
  sed -i "s|^DB_PASSWORD=.*|DB_PASSWORD=$(rand_hex 18)|" .env
  sed -i "s|^MINIO_ACCESS_KEY=.*|MINIO_ACCESS_KEY=vh$(rand_hex 8)|" .env
  sed -i "s|^MINIO_SECRET_KEY=.*|MINIO_SECRET_KEY=$(rand_hex 24)|" .env
  sed -i "s|^WEB_PORT=.*|WEB_PORT=$WEB_PORT|" .env
  if [[ "$(id -u)" == "0" ]]; then
    sed -i "s|^SERVICE_UID=.*|SERVICE_UID=1001|" .env
    sed -i "s|^SERVICE_GID=.*|SERVICE_GID=1001|" .env
  else
    sed -i "s|^SERVICE_UID=.*|SERVICE_UID=$(id -u)|" .env
    sed -i "s|^SERVICE_GID=.*|SERVICE_GID=$(id -g)|" .env
  fi
  if [[ -S /var/run/docker.sock ]]; then
    docker_gid="$(stat -c '%g' /var/run/docker.sock)"
    sed -i "s|^DOCKER_GID=.*|DOCKER_GID=$docker_gid|" .env
  fi
  echo "[install] generated .env"
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

mkdir -p "${DATA_DIR:-$DATA_DIR_DEFAULT}" .secrets
SERVICE_UID="${SERVICE_UID:-1001}"
SERVICE_GID="${SERVICE_GID:-1001}"
if [[ "$(id -u)" == "0" ]]; then
  chown -R "${SERVICE_UID}:${SERVICE_GID}" "${DATA_DIR:-$DATA_DIR_DEFAULT}" .secrets
else
  if [[ "$SERVICE_UID" != "$(id -u)" || "$SERVICE_GID" != "$(id -g)" ]]; then
    echo "[install] non-root install requires SERVICE_UID/SERVICE_GID to match installer user. Current: $(id -u):$(id -g), configured: ${SERVICE_UID}:${SERVICE_GID}" >&2
    exit 1
  fi
fi
if ! chmod u+rwx "${DATA_DIR:-$DATA_DIR_DEFAULT}" .secrets 2>/dev/null; then
  echo "[install] warning: could not chmod DATA_DIR/.secrets" >&2
fi
if [[ ! -w "${DATA_DIR:-$DATA_DIR_DEFAULT}" || ! -w .secrets ]]; then
  echo "[install] DATA_DIR or .secrets is not writable by service/install user" >&2
  exit 1
fi
if [[ -d "${MASTER_KEY_FILE:-./.secrets/vulnhunt-master.key}" ]]; then
  echo "[install] master key path is a directory: ${MASTER_KEY_FILE}" >&2
  exit 1
fi
if [[ ! -f "${MASTER_KEY_FILE:-./.secrets/vulnhunt-master.key}" ]]; then
  openssl rand -hex 32 > "${MASTER_KEY_FILE:-./.secrets/vulnhunt-master.key}"
  chmod 0400 "${MASTER_KEY_FILE:-./.secrets/vulnhunt-master.key}"
  echo "[install] generated master key: ${MASTER_KEY_FILE:-./.secrets/vulnhunt-master.key}"
fi
if [[ "$(id -u)" == "0" ]]; then
  chown "${SERVICE_UID}:${SERVICE_GID}" "${MASTER_KEY_FILE:-./.secrets/vulnhunt-master.key}"
fi
chmod 0400 "${MASTER_KEY_FILE:-./.secrets/vulnhunt-master.key}"
if [[ ! -f "${LICENSE_PUBLIC_KEY_FILE:-./.secrets/license-public.pem}" ]]; then
  cat > "${LICENSE_PUBLIC_KEY_FILE:-./.secrets/license-public.pem}" <<'EOF'
# license public key placeholder; replace before production license enforcement
EOF
  chmod 0444 "${LICENSE_PUBLIC_KEY_FILE:-./.secrets/license-public.pem}"
fi
if [[ "$(id -u)" == "0" ]]; then
  chown "${SERVICE_UID}:${SERVICE_GID}" "${LICENSE_PUBLIC_KEY_FILE:-./.secrets/license-public.pem}"
fi
chmod 0444 "${LICENSE_PUBLIC_KEY_FILE:-./.secrets/license-public.pem}"

if [[ -d images ]]; then
  for img in images/*.tar; do
    [[ -f "$img" ]] || continue
    echo "[install] loading image $img"
    docker load -i "$img"
  done
fi

echo "[install] starting VulnHunt..."
docker compose up -d

url="http://127.0.0.1:${WEB_PORT}/api/system/status"
for i in {1..60}; do
  if curl -fsS "$url" >/dev/null 2>&1; then
    echo "[install] service is ready"
    break
  fi
  if [[ "$i" == 60 ]]; then
    echo "[install] timed out waiting for $url" >&2
    docker compose ps
    exit 1
  fi
  sleep 2
done

machine_code="$(curl -fsS "$url" | sed -n 's/.*"installationId":"\([^"]*\)".*/\1/p')"
echo ""
echo "VulnHunt installed."
echo "URL: http://$(hostname -I 2>/dev/null | awk '{print $1}'):${WEB_PORT}/"
echo "Local URL: http://127.0.0.1:${WEB_PORT}/"
[[ -n "$machine_code" ]] && echo "Machine code: $machine_code"
echo "Next: open /activate, import license, bootstrap admin, configure model credential."
