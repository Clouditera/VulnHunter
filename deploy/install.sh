#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

WEB_PORT="${WEB_PORT:-23000}"
DATA_DIR_DEFAULT="/opt/vulnagent/data"

rand_hex() { openssl rand -hex "$1"; }
require_cmd() { command -v "$1" >/dev/null 2>&1 || { echo "[install] missing command: $1" >&2; exit 1; }; }
compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose "$@"
  else
    echo "[install] Docker Compose is required: install Docker Compose v2 ('docker compose') or legacy docker-compose" >&2
    return 127
  fi
}

require_cmd docker
require_cmd openssl
require_cmd curl
if ! compose version >/dev/null; then
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

is_tty() { [[ -t 0 && -t 1 ]]; }
default_data_dir() {
  if [[ "$(id -u)" == "0" ]]; then
    printf '%s\n' "$DATA_DIR_DEFAULT"
  else
    printf '%s\n' "${HOME:-/tmp}/vulnagent-data"
  fi
}
port_available() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ! ss -ltn "sport = :$port" | grep -q ":$port"
  else
    ! (echo >"/dev/tcp/127.0.0.1/$port") >/dev/null 2>&1
  fi
}

if [[ ! -f .env ]]; then
  if [[ -z "${DATA_DIR:-}" ]] && ! is_tty; then
    echo "[install] DATA_DIR is required in non-interactive first install." >&2
    echo "Example: DATA_DIR=/opt/vulnagent/data WEB_PORT=23000 ./install.sh" >&2
    exit 1
  fi

  data_dir="${DATA_DIR:-$(default_data_dir)}"
  web_port="${WEB_PORT:-23000}"

  if [[ -z "${DATA_DIR:-}" ]] && is_tty; then
    echo "VulnAgent 安装向导"
    echo ""
    echo "数据目录会保存数据库、扫描工作区、报告、对象存储和授权状态。"
    echo "请使用持久化磁盘路径，不建议使用 /tmp。"
    echo ""
    read -r -p "请选择数据目录 DATA_DIR [$data_dir]: " input_data_dir
    data_dir="${input_data_dir:-$data_dir}"
    read -r -p "请选择 Web 访问端口 WEB_PORT [$web_port]: " input_web_port
    web_port="${input_web_port:-$web_port}"
    echo ""
    echo "安装配置："
    echo "- 数据目录：$data_dir"
    echo "- Web 端口：$web_port"
    echo ""
    read -r -p "确认开始安装？[Y/n] " confirm
    case "${confirm:-Y}" in
      y|Y|yes|YES) ;;
      *) echo "[install] cancelled"; exit 0 ;;
    esac
  fi

  if [[ "$data_dir" != /* ]]; then
    echo "[install] DATA_DIR must be an absolute host path: $data_dir" >&2
    exit 1
  fi
  if ! [[ "$web_port" =~ ^[0-9]+$ ]] || (( web_port < 1 || web_port > 65535 )); then
    echo "[install] WEB_PORT must be a number between 1 and 65535: $web_port" >&2
    exit 1
  fi
  if ! mkdir -p "$data_dir" 2>/dev/null || [[ ! -w "$data_dir" ]]; then
    echo "[install] 当前用户无法写入数据目录：$data_dir" >&2
    echo "请选择其他目录，例如：${HOME:-/tmp}/vulnagent-data" >&2
    exit 1
  fi
  if ! port_available "$web_port"; then
    echo "[install] WEB_PORT is already in use: $web_port" >&2
    exit 1
  fi

  cp .env.example .env
  sed -i "s|^DATA_DIR=.*|DATA_DIR=$data_dir|" .env
  sed -i "s|^DB_PASSWORD=.*|DB_PASSWORD=$(rand_hex 18)|" .env
  sed -i "s|^MINIO_ACCESS_KEY=.*|MINIO_ACCESS_KEY=vh$(rand_hex 8)|" .env
  sed -i "s|^MINIO_SECRET_KEY=.*|MINIO_SECRET_KEY=$(rand_hex 24)|" .env
  sed -i "s|^WEB_PORT=.*|WEB_PORT=$web_port|" .env
  default_edition="$(grep -E '^EDITION=' .env | tail -n 1 | cut -d= -f2-)"
  sed -i "s|^EDITION=.*|EDITION=${EDITION:-${default_edition:-community}}|" .env
  master_key_file="$data_dir/.secrets/vulnagent-master.key"
  sed -i "s|^MASTER_KEY_FILE=.*|MASTER_KEY_FILE=$master_key_file|" .env
  sed -i "s|^VULNAGENT_MASTER_KEY_FILE=.*|VULNAGENT_MASTER_KEY_FILE=$master_key_file|" .env
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

if [[ "${DATA_DIR:-$DATA_DIR_DEFAULT}" != /* ]]; then
  echo "[install] DATA_DIR must be an absolute host path: ${DATA_DIR:-$DATA_DIR_DEFAULT}" >&2
  exit 1
fi
mkdir -p "${DATA_DIR:-$DATA_DIR_DEFAULT}" "${DATA_DIR:-$DATA_DIR_DEFAULT}/db" "${DATA_DIR:-$DATA_DIR_DEFAULT}/minio" "$(dirname "${MASTER_KEY_FILE:-./.secrets/vulnagent-master.key}")" .secrets
SERVICE_UID="${SERVICE_UID:-1001}"
SERVICE_GID="${SERVICE_GID:-1001}"
if [[ "$(id -u)" == "0" ]]; then
  chown -R "${SERVICE_UID}:${SERVICE_GID}" "${DATA_DIR:-$DATA_DIR_DEFAULT}" "$(dirname "${MASTER_KEY_FILE:-./.secrets/vulnagent-master.key}")" .secrets
  chown -R 70:70 "${DATA_DIR:-$DATA_DIR_DEFAULT}/db" 2>/dev/null || echo "[install] warning: could not chown Postgres data dir to uid 70" >&2
else
  if [[ "$SERVICE_UID" != "$(id -u)" || "$SERVICE_GID" != "$(id -g)" ]]; then
    echo "[install] non-root install requires SERVICE_UID/SERVICE_GID to match installer user. Current: $(id -u):$(id -g), configured: ${SERVICE_UID}:${SERVICE_GID}" >&2
    exit 1
  fi
  if command -v setfacl >/dev/null 2>&1; then
    setfacl -R -m u:70:rwX -m d:u:70:rwX "${DATA_DIR:-$DATA_DIR_DEFAULT}/db" 2>/dev/null || chmod -R a+rwX "${DATA_DIR:-$DATA_DIR_DEFAULT}/db"
  else
    chmod -R a+rwX "${DATA_DIR:-$DATA_DIR_DEFAULT}/db"
  fi
fi
if ! chmod u+rwx "${DATA_DIR:-$DATA_DIR_DEFAULT}" "${DATA_DIR:-$DATA_DIR_DEFAULT}/minio" "$(dirname "${MASTER_KEY_FILE:-./.secrets/vulnagent-master.key}")" .secrets 2>/dev/null; then
  echo "[install] warning: could not chmod DATA_DIR/.secrets" >&2
fi
if [[ ! -w "${DATA_DIR:-$DATA_DIR_DEFAULT}" || ! -w "$(dirname "${MASTER_KEY_FILE:-./.secrets/vulnagent-master.key}")" || ! -w .secrets ]]; then
  echo "[install] DATA_DIR, master key directory, or .secrets is not writable by service/install user" >&2
  exit 1
fi
if [[ -d "${MASTER_KEY_FILE:-./.secrets/vulnagent-master.key}" ]]; then
  echo "[install] master key path is a directory: ${MASTER_KEY_FILE}" >&2
  exit 1
fi
if [[ ! -f "${MASTER_KEY_FILE:-./.secrets/vulnagent-master.key}" ]]; then
  openssl rand -hex 32 > "${MASTER_KEY_FILE:-./.secrets/vulnagent-master.key}"
  chmod 0400 "${MASTER_KEY_FILE:-./.secrets/vulnagent-master.key}"
  echo "[install] generated master key: ${MASTER_KEY_FILE:-./.secrets/vulnagent-master.key}"
fi
if [[ "$(id -u)" == "0" ]]; then
  chown "${SERVICE_UID}:${SERVICE_GID}" "${MASTER_KEY_FILE:-./.secrets/vulnagent-master.key}"
fi
chmod 0400 "${MASTER_KEY_FILE:-./.secrets/vulnagent-master.key}"

if [[ -f checksums.sha256 ]]; then
  echo "[install] verifying release files..."
  sha256sum -c checksums.sha256
fi

if [[ -d images ]]; then
  for img in images/*.tar; do
    [[ -f "$img" ]] || continue
    echo "[install] loading image $img"
    docker load -i "$img"
  done
fi

echo "[install] starting VulnAgent..."
compose up -d

url="http://127.0.0.1:${WEB_PORT}/api/system/status"
for i in {1..60}; do
  if curl -fsS "$url" >/dev/null 2>&1; then
    echo "[install] service is ready"
    break
  fi
  if [[ "$i" == 60 ]]; then
    echo "[install] timed out waiting for $url" >&2
    compose ps
    exit 1
  fi
  sleep 2
done

machine_code="$(curl -fsS "$url" | sed -n 's/.*"installationId":"\([^"]*\)".*/\1/p')"
echo ""
echo "VulnAgent installed."
echo "URL: http://$(hostname -I 2>/dev/null | awk '{print $1}'):${WEB_PORT}/"
echo "Local URL: http://127.0.0.1:${WEB_PORT}/"
[[ -n "$machine_code" ]] && echo "Machine code: $machine_code"
echo "Next: open /activate, import license, bootstrap admin, configure model credential."
