#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

WEB_PORT="${WEB_PORT:-23000}"
DATA_DIR_DEFAULT="/opt/vulnhunter/data"

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
json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  printf '%s' "$s"
}
version_field() {
  local key="$1"
  [[ -f VERSION.json ]] || return 0
  sed -n "s/.*\"$key\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" VERSION.json | head -n 1
}
container_exists() {
  docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$1"
}
image_exists() {
  docker image inspect "$1" >/dev/null 2>&1
}
required_images() {
  printf '%s\n' \
    "${SERVICE_IMAGE:-vulnhunter-service:latest}" \
    "${WEB_IMAGE:-vulnhunter-web:latest}" \
    "${WORKER_IMAGE:-vulnhunter-worker:latest}" \
    "${EVAL_WORKER_IMAGE:-vulnhunter-eval-worker:latest}" \
    "${POSTGRES_IMAGE:-postgres:16-alpine}" \
    "${MINIO_IMAGE:-minio/minio:RELEASE.2025-09-07T16-13-09Z}" \
    | awk 'NF && !seen[$0]++'
}
validate_local_images() {
  local missing=()
  while IFS= read -r image; do
    [[ -n "$image" ]] || continue
    if ! image_exists "$image"; then
      missing+=("$image")
    fi
  done < <(required_images)
  if (( ${#missing[@]} > 0 )); then
    echo "[install] required Docker images are missing locally; refusing to contact external registries." >&2
    printf '[install] missing image: %s\n' "${missing[@]}" >&2
    echo "[install] Ensure the offline release images/*.tar files are present and rerun ./install.sh." >&2
    exit 1
  fi
}
compose_up_detached() {
  if docker compose version >/dev/null 2>&1; then
    docker compose up -d --pull never
  elif command -v docker-compose >/dev/null 2>&1; then
    validate_local_images
    docker-compose up -d --no-build
  else
    echo "[install] Docker Compose is required: install Docker Compose v2 ('docker compose') or legacy docker-compose" >&2
    return 127
  fi
}
non_empty_dir() {
  local dir="$1"
  [[ -d "$dir" ]] || return 1
  find "$dir" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null | grep -q .
}
existing_install_marker() {
  local data_dir="$1"
  if [[ -f .vulnhunter-install.json ]]; then echo ".vulnhunter-install.json"; return 0; fi
  if [[ -f .env ]]; then echo ".env"; return 0; fi
  if [[ -f "$data_dir/.secrets/vulnhunter-master.key" ]]; then echo "$data_dir/.secrets/vulnhunter-master.key"; return 0; fi
  if [[ -f "$data_dir/.install_id" ]]; then echo "$data_dir/.install_id"; return 0; fi
  if [[ -f "$data_dir/db/PG_VERSION" ]] || non_empty_dir "$data_dir/db"; then echo "$data_dir/db"; return 0; fi
  if non_empty_dir "$data_dir/minio"; then echo "$data_dir/minio"; return 0; fi
  for c in vulnhunter-service vulnhunter-web vulnhunter-db vulnhunter-minio; do
    if container_exists "$c"; then echo "container:$c"; return 0; fi
  done
  return 1
}
refuse_existing_install() {
  local marker="$1"
  echo "[install] existing VulnHunter installation marker detected: $marker" >&2
  echo "[install] install.sh is only for a clean first install directory." >&2
  echo "[install] For same-directory upgrades, run: ./upgrade.sh" >&2
  echo "[install] If .env is missing but old DATA_DIR still exists, restore the old .env from backup or contact support; refusing to generate new secrets over existing data." >&2
  exit 1
}
write_install_manifest() {
  local status_json="$1"
  local now version git_commit youngflow install_id tmp
  now="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
  version="$(version_field version)"
  git_commit="$(version_field gitCommit)"
  youngflow="$(version_field youngflowVersion)"
  install_id="$(printf '%s' "$status_json" | sed -n 's/.*"installation_id":"\([^"]*\)".*/\1/p')"
  [[ -n "$install_id" ]] || install_id="$(printf '%s' "$status_json" | sed -n 's/.*"machine_code":"\([^"]*\)".*/\1/p')"
  tmp=".vulnhunter-install.json.tmp"
  cat > "$tmp" << JSON
{
  "schema_version": 1,
  "product": "vulnhunter",
  "install_dir": "$(json_escape "$ROOT")",
  "data_dir": "$(json_escape "${DATA_DIR:-$DATA_DIR_DEFAULT}")",
  "edition": "$(json_escape "${EDITION:-community}")",
  "installed_at": "$now",
  "updated_at": "$now",
  "installation_id": "$(json_escape "$install_id")",
  "installed_version": {
    "version": "$(json_escape "$version")",
    "git_commit": "$(json_escape "$git_commit")",
    "youngflow_version": "$(json_escape "$youngflow")"
  },
  "current_version": {
    "version": "$(json_escape "$version")",
    "git_commit": "$(json_escape "$git_commit")",
    "youngflow_version": "$(json_escape "$youngflow")"
  },
  "compose": {
    "file": "docker-compose.yml",
    "network": "vulnhunter-internal",
    "containers": ["vulnhunter-web", "vulnhunter-service", "vulnhunter-db", "vulnhunter-minio"]
  },
  "managed_files": [
    { "path": ".env", "kind": "config", "preserve": true, "secret_values": true },
    { "path": ".secrets/license-public.pem", "kind": "license_public_key", "preserve": true, "secret_values": false },
    { "path": "${DATA_DIR}/.secrets/vulnhunter-master.key", "kind": "master_key", "preserve": true, "secret_values": true },
    { "path": "${DATA_DIR}/.install_id", "kind": "installation_id", "preserve": true, "secret_values": false }
  ],
  "managed_dirs": [
    { "path": "${DATA_DIR}/db", "kind": "postgres_data", "preserve": true },
    { "path": "${DATA_DIR}/minio", "kind": "object_storage", "preserve": true },
    { "path": "${DATA_DIR}/workspaces", "kind": "worker_workspaces", "preserve": true }
  ],
  "release_images": {
    "service": "$(json_escape "${SERVICE_IMAGE:-}")",
    "web": "$(json_escape "${WEB_IMAGE:-}")",
    "worker": "$(json_escape "${WORKER_IMAGE:-}")",
    "evalWorker": "$(json_escape "${EVAL_WORKER_IMAGE:-}")"
  }
}
JSON
  mv "$tmp" .vulnhunter-install.json
  echo "[install] wrote install manifest: .vulnhunter-install.json"
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
    printf '%s\n' "${HOME:-/tmp}/vulnhunter-data"
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

candidate_data_dir="${DATA_DIR:-$(default_data_dir)}"
if marker="$(existing_install_marker "$candidate_data_dir")"; then
  refuse_existing_install "$marker"
fi

if [[ ! -f .env ]]; then
  if [[ -z "${DATA_DIR:-}" ]] && ! is_tty; then
    echo "[install] DATA_DIR is required in non-interactive first install." >&2
    echo "Example: DATA_DIR=/opt/vulnhunter/data WEB_PORT=23000 ./install.sh" >&2
    exit 1
  fi

  data_dir="${DATA_DIR:-$(default_data_dir)}"
  web_port="${WEB_PORT:-23000}"

  if [[ -z "${DATA_DIR:-}" ]] && is_tty; then
    echo "VulnHunter 安装向导"
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
    echo "请选择其他目录，例如：${HOME:-/tmp}/vulnhunter-data" >&2
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
  master_key_file="$data_dir/.secrets/vulnhunter-master.key"
  sed -i "s|^MASTER_KEY_FILE=.*|MASTER_KEY_FILE=$master_key_file|" .env
  sed -i "s|^VULNHUNTER_MASTER_KEY_FILE=.*|VULNHUNTER_MASTER_KEY_FILE=$master_key_file|" .env
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
mkdir -p "${DATA_DIR:-$DATA_DIR_DEFAULT}" "${DATA_DIR:-$DATA_DIR_DEFAULT}/db" "${DATA_DIR:-$DATA_DIR_DEFAULT}/minio" "$(dirname "${MASTER_KEY_FILE:-./.secrets/vulnhunter-master.key}")" .secrets
SERVICE_UID="${SERVICE_UID:-1001}"
SERVICE_GID="${SERVICE_GID:-1001}"
if [[ "$(id -u)" == "0" ]]; then
  chown -R "${SERVICE_UID}:${SERVICE_GID}" "${DATA_DIR:-$DATA_DIR_DEFAULT}" "$(dirname "${MASTER_KEY_FILE:-./.secrets/vulnhunter-master.key}")" .secrets
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
if ! chmod u+rwx "${DATA_DIR:-$DATA_DIR_DEFAULT}" "${DATA_DIR:-$DATA_DIR_DEFAULT}/minio" "$(dirname "${MASTER_KEY_FILE:-./.secrets/vulnhunter-master.key}")" .secrets 2>/dev/null; then
  echo "[install] warning: could not chmod DATA_DIR/.secrets" >&2
fi
if [[ ! -w "${DATA_DIR:-$DATA_DIR_DEFAULT}" || ! -w "$(dirname "${MASTER_KEY_FILE:-./.secrets/vulnhunter-master.key}")" || ! -w .secrets ]]; then
  echo "[install] DATA_DIR, master key directory, or .secrets is not writable by service/install user" >&2
  exit 1
fi
if [[ -d "${MASTER_KEY_FILE:-./.secrets/vulnhunter-master.key}" ]]; then
  echo "[install] master key path is a directory: ${MASTER_KEY_FILE}" >&2
  exit 1
fi
if [[ ! -f "${MASTER_KEY_FILE:-./.secrets/vulnhunter-master.key}" ]]; then
  openssl rand -hex 32 > "${MASTER_KEY_FILE:-./.secrets/vulnhunter-master.key}"
  chmod 0400 "${MASTER_KEY_FILE:-./.secrets/vulnhunter-master.key}"
  echo "[install] generated master key: ${MASTER_KEY_FILE:-./.secrets/vulnhunter-master.key}"
fi
if [[ "$(id -u)" == "0" ]]; then
  chown "${SERVICE_UID}:${SERVICE_GID}" "${MASTER_KEY_FILE:-./.secrets/vulnhunter-master.key}"
fi
chmod 0400 "${MASTER_KEY_FILE:-./.secrets/vulnhunter-master.key}"

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
validate_local_images

echo "[install] starting VulnHunter..."
compose_up_detached

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

status_json="$(curl -fsS "$url")"
write_install_manifest "$status_json"
machine_code="$(printf '%s' "$status_json" | sed -n 's/.*"installation_id":"\([^"]*\)".*/\1/p')"
[[ -n "$machine_code" ]] || machine_code="$(printf '%s' "$status_json" | sed -n 's/.*"machine_code":"\([^"]*\)".*/\1/p')"
echo ""
echo "VulnHunter installed."
echo "URL: http://$(hostname -I 2>/dev/null | awk '{print $1}'):${WEB_PORT}/"
echo "Local URL: http://127.0.0.1:${WEB_PORT}/"
[[ -n "$machine_code" ]] && echo "Machine code: $machine_code"
echo "Next: open /activate, import license, bootstrap admin, configure model credential."
if [[ -x "./sandbox/install.sh" ]]; then
  echo "Optional dynamic sandboxes: ./sandbox/install.sh   # same-host wiring"
  echo "  (remote host: ./sandbox/install.sh --remote)"
fi
