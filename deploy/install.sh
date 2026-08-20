#!/usr/bin/env bash
# VulnHunter installer v2 — self-contained INSTANCE_DIR (design batch 1).
# Fresh install writes .env / compose / .version into INSTANCE_DIR (= DATA_DIR).
# Package directory may be deleted after a successful install.
set -euo pipefail

PKG_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/instance-dir.sh
source "$PKG_ROOT/lib/instance-dir.sh"
# shellcheck source=lib/common.sh
source "$PKG_ROOT/lib/common.sh"

cd "$PKG_ROOT"

# Fatal-error helper (install.sh historically used inline `echo ...; exit 1`;
# the parallel-load block introduced `die` calls — define it here so failure
# branches print a readable message instead of `die: command not found`).
die() { echo "[install] ERROR: $*" >&2; exit 1; }

INSTANCE_DIR_DEFAULT="/opt/vulnhunter/data"
WEB_PORT_DEFAULT=23000

rand_hex() { openssl rand -hex "$1"; }
require_cmd() { command -v "$1" >/dev/null 2>&1 || { echo "[install] missing command: $1" >&2; exit 1; }; }
version_field() {
  local key="$1"
  [[ -f "$PKG_ROOT/VERSION.json" ]] || return 0
  sed -n "s/.*\"$key\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$PKG_ROOT/VERSION.json" | head -n 1
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
non_empty_dir() {
  local dir="$1"
  [[ -d "$dir" ]] || return 1
  find "$dir" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null | grep -q .
}
is_tty() { [[ -t 0 && -t 1 ]]; }
port_available() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ! ss -ltn "sport = :$port" | grep -q ":$port"
  else
    ! (echo >"/dev/tcp/127.0.0.1/$port") >/dev/null 2>&1
  fi
}
default_instance_dir() {
  if [[ "$(id -u)" == "0" ]]; then
    printf '%s\n' "$INSTANCE_DIR_DEFAULT"
  else
    printf '%s\n' "${HOME:-/tmp}/vulnhunter-data"
  fi
}

usage() {
  cat <<EOF
Usage: ./install.sh [--dir INSTANCE_DIR] [--web-port PORT]

  Fresh install into a self-contained instance directory (default: $(default_instance_dir)).
  After success the release package directory may be deleted.

  Env overrides: INSTANCE_DIR / DATA_DIR, WEB_PORT, EDITION, PROJECT_NAME

  Upgrade of an existing instance is batch 2 (not this installer yet).
  If INSTANCE_DIR already has .version, this script refuses.
EOF
}

# ── args ──────────────────────────────────────────────────────────
INSTANCE_DIR_ARG=""
WEB_PORT_ARG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)
      INSTANCE_DIR_ARG="${2:-}"; shift 2 || true
      ;;
    --dir=*)
      INSTANCE_DIR_ARG="${1#*=}"; shift
      ;;
    --web-port)
      WEB_PORT_ARG="${2:-}"; shift 2 || true
      ;;
    --web-port=*)
      WEB_PORT_ARG="${1#*=}"; shift
      ;;
    --force)
      FORCE=1; shift
      ;;
    --with-running)
      WITH_RUNNING=1; shift
      ;;
    -h|--help)
      usage; exit 0
      ;;
    *)
      echo "[install] unknown arg: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

require_cmd docker
require_cmd openssl
require_cmd curl
if ! docker compose version >/dev/null 2>&1 && ! command -v docker-compose >/dev/null 2>&1; then
  echo "[install] Docker Compose is required" >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "[install] Docker daemon is not reachable" >&2
  exit 1
fi

arch="$(uname -m)"
if [[ "$arch" != "x86_64" && "$arch" != "amd64" && "$arch" != "aarch64" && "$arch" != "arm64" ]]; then
  echo "[install] unsupported architecture: $arch (x86_64/arm64 required)" >&2
  exit 1
fi

mem_kb="$(awk '/MemTotal/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)"
if (( mem_kb > 0 && mem_kb < 32*1024*1024 )); then
  echo "[install] warning: memory below recommended 32GiB; install smoke can run, large scans may need lower concurrency" >&2
fi

# Resolve INSTANCE_DIR (= DATA_DIR)
instance_dir="${INSTANCE_DIR_ARG:-${INSTANCE_DIR:-${DATA_DIR:-}}}"
web_port="${WEB_PORT_ARG:-${WEB_PORT:-$WEB_PORT_DEFAULT}}"

if [[ -z "$instance_dir" ]]; then
  instance_dir="$(default_instance_dir)"
  if is_tty; then
    echo "VulnHunter 安装向导（自包含实例目录）"
    echo ""
    echo "实例目录会保存配置、编排、数据库、工作区与密钥；装完后安装包可删。"
    echo ""
    read -r -p "请选择实例目录 INSTANCE_DIR [$instance_dir]: " input_dir
    instance_dir="${input_dir:-$instance_dir}"
    read -r -p "请选择 Web 访问端口 WEB_PORT [$web_port]: " input_port
    web_port="${input_port:-$web_port}"
    echo ""
    echo "安装配置："
    echo "- 实例目录：$instance_dir"
    echo "- Web 端口：$web_port"
    echo ""
    read -r -p "确认开始安装？[Y/n] " confirm
    case "${confirm:-Y}" in
      y|Y|yes|YES) ;;
      *) echo "[install] cancelled"; exit 0 ;;
    esac
  elif [[ -z "${INSTANCE_DIR:-}${DATA_DIR:-}" ]]; then
    echo "[install] INSTANCE_DIR (or DATA_DIR) is required in non-interactive first install." >&2
    echo "Example: INSTANCE_DIR=/opt/vulnhunter/data WEB_PORT=23000 ./install.sh" >&2
    exit 1
  fi
fi

if [[ "$instance_dir" != /* ]]; then
  echo "[install] INSTANCE_DIR must be an absolute host path: $instance_dir" >&2
  exit 1
fi
if ! [[ "$web_port" =~ ^[0-9]+$ ]] || (( web_port < 1 || web_port > 65535 )); then
  echo "[install] WEB_PORT must be a number between 1 and 65535: $web_port" >&2
  exit 1
fi

# Existing self-contained instance → upgrade mode (batch 2: install.sh doubles as upgrader)
if instance_is_present "$instance_dir"; then
  echo "[install] existing instance detected: $instance_dir — switching to upgrade mode"
  # shellcheck source=lib/instance-upgrade.sh
  source "$PKG_ROOT/lib/instance-upgrade.sh"
  run_instance_upgrade "$PKG_ROOT" "$instance_dir"
  exit $?
fi

# Refuse stomping live data without .version (old layout / partial install)
if [[ -f "$instance_dir/.secrets/vulnhunter-master.key" ]] \
  || [[ -f "$instance_dir/.install_id" ]] \
  || [[ -f "$instance_dir/db/PG_VERSION" ]] \
  || non_empty_dir "$instance_dir/db" \
  || non_empty_dir "$instance_dir/minio"; then
  echo "[install] existing data under $instance_dir without .version — refusing to overwrite." >&2
  echo "[install] Old-layout import is batch 3. Restore a backup or pick a fresh INSTANCE_DIR." >&2
  exit 1
fi

# Fixed container names still global — refuse if stack already running
for c in vulnhunter-service vulnhunter-web vulnhunter-db vulnhunter-minio vulnhunter-admin-api vulnhunter-admin-web; do
  if container_exists "$c"; then
    echo "[install] container already exists: $c — remove old stack or choose another host." >&2
    exit 1
  fi
done

if ! mkdir -p "$instance_dir" 2>/dev/null || [[ ! -w "$instance_dir" ]]; then
  echo "[install] cannot write instance directory: $instance_dir" >&2
  exit 1
fi
if ! port_available "$web_port"; then
  echo "[install] WEB_PORT is already in use: $web_port" >&2
  exit 1
fi

[[ -f "$PKG_ROOT/.env.example" ]] || { echo "[install] missing .env.example in package" >&2; exit 1; }
[[ -f "$PKG_ROOT/docker-compose.yml" ]] || { echo "[install] missing docker-compose.yml in package" >&2; exit 1; }

project_name="${PROJECT_NAME:-$(project_name_from_dir "$instance_dir")}"
master_key_file="$instance_dir/.secrets/vulnhunter-master.key"
license_key_file="$instance_dir/.secrets/license-public.pem"

mkdir -p "$instance_dir/.secrets" "$instance_dir/db" "$instance_dir/minio" "$instance_dir/workspaces" "$instance_dir/chat-sessions"

# ── generate .env into instance ───────────────────────────────────
cp "$PKG_ROOT/.env.example" "$instance_dir/.env"
cp "$PKG_ROOT/.env.example" "$instance_dir/.env.template"
cp "$PKG_ROOT/docker-compose.yml" "$instance_dir/docker-compose.yml"

# License public key (required mount)
if [[ -f "$PKG_ROOT/.secrets/license-public.pem" ]]; then
  cp -f "$PKG_ROOT/.secrets/license-public.pem" "$license_key_file"
  chmod 0444 "$license_key_file" 2>/dev/null || true
else
  # Community packs ship without a license public key. Touch a placeholder so the
  # compose bind-mount path exists; enterprise/saas activation is N/A.
  : > "$license_key_file"
  chmod 0444 "$license_key_file" 2>/dev/null || true
  echo "[install] note: no license-public.pem in package (community) — placeholder at $license_key_file" >&2
fi

# Host hardware identity (HALL-12): capture the DMI product UUID into the
# instance so the containers derive a reinstall-stable machine code without
# bind-mounting /sys (which would break container startup on DMI-less hosts).
# Unreadable/missing/invalid → empty file → legacy .install_id fallback.
host_dmi_file="$instance_dir/.secrets/host-product-uuid"
if capture_host_dmi_product_uuid "$host_dmi_file"; then
  echo "[install] captured host DMI product UUID for hardware-bound machine code"
else
  echo "[install] no usable host DMI product UUID — machine code will use the legacy .install_id fallback"
fi

# Patch instance .env
set_env_key() {
  local file="$1" key="$2" val="$3"
  file="$(readlink -f "$file")"
  if grep -qE "^${key}=" "$file" 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${val}|" "$file"
  else
    printf '%s=%s\n' "$key" "$val" >>"$file"
  fi
}

set_env_key "$instance_dir/.env" DATA_DIR "$instance_dir"
set_env_key "$instance_dir/.env" DB_PASSWORD "$(rand_hex 18)"
set_env_key "$instance_dir/.env" MINIO_ACCESS_KEY "vh$(rand_hex 8)"
set_env_key "$instance_dir/.env" MINIO_SECRET_KEY "$(rand_hex 24)"
set_env_key "$instance_dir/.env" WEB_PORT "$web_port"
default_edition="$(grep -E '^EDITION=' "$instance_dir/.env" | tail -n 1 | cut -d= -f2- || true)"
set_env_key "$instance_dir/.env" EDITION "${EDITION:-${default_edition:-community}}"
set_env_key "$instance_dir/.env" MASTER_KEY_FILE "$master_key_file"
set_env_key "$instance_dir/.env" VULNHUNTER_MASTER_KEY_FILE "$master_key_file"
set_env_key "$instance_dir/.env" LICENSE_PUBLIC_KEY_FILE "$license_key_file"
set_env_key "$instance_dir/.env" HOST_DMI_PRODUCT_UUID_FILE "$host_dmi_file"
set_env_key "$instance_dir/.env" PROJECT_NAME "$project_name"
set_env_key "$instance_dir/.env" COMPOSE_PROJECT_NAME "$project_name"

# Chat/worker containers must join THIS stack's network — single-point derive
# from the project name (23130 lesson: hardcoded vulnhunter-internal spawned
# chat workers onto another stack's network). Legacy upgrades keep their
# existing DOCKER_NETWORK via the .env merge; fresh installs derive.
docker_network="${DOCKER_NETWORK:-${project_name}-internal}"
set_env_key "$instance_dir/.env" DOCKER_NETWORK "$docker_network"
if [[ -z "${DOCKER_SUBNET:-}" ]]; then
  # Derive a /24 third octet from the project name (1..250) so multiple
  # derived stacks don't fight over the legacy 10.177.0.0/24 pool.
  octet=$(( $(printf '%s' "$project_name" | cksum | cut -d' ' -f1) % 250 + 1 ))
  set_env_key "$instance_dir/.env" DOCKER_SUBNET "10.177.${octet}.0/24"
fi

# System admin (seed-once, fish 2026-08-07): env credentials consumed ONLY on
# first boot when no admin exists in DB. Once seeded, DB is authoritative —
# change passwords via the admin UI, not these env keys.
# Fresh installs get a generated password; operators may pre-set
# VULNHUNTER_ADMIN_EMAIL / VULNHUNTER_ADMIN_PASSWORD to override.
admin_email="${VULNHUNTER_ADMIN_EMAIL:-admin@vulnhunter.local}"
admin_password="${VULNHUNTER_ADMIN_PASSWORD:-$(rand_hex 12)}"
set_env_key "$instance_dir/.env" VULNHUNTER_ADMIN_EMAIL "$admin_email"
set_env_key "$instance_dir/.env" VULNHUNTER_ADMIN_PASSWORD "$admin_password"

if [[ "$(id -u)" == "0" ]]; then
  set_env_key "$instance_dir/.env" SERVICE_UID "1001"
  set_env_key "$instance_dir/.env" SERVICE_GID "1001"
else
  set_env_key "$instance_dir/.env" SERVICE_UID "$(id -u)"
  set_env_key "$instance_dir/.env" SERVICE_GID "$(id -g)"
fi
if [[ -S /var/run/docker.sock ]]; then
  set_env_key "$instance_dir/.env" DOCKER_GID "$(stat -c '%g' /var/run/docker.sock)"
fi

echo "[install] wrote $instance_dir/.env (+ .env.template, docker-compose.yml)"

# Load env for subsequent steps
set -a
# shellcheck disable=SC1091
source "$instance_dir/.env"
set +a

SERVICE_UID="${SERVICE_UID:-1001}"
SERVICE_GID="${SERVICE_GID:-1001}"

if [[ "$(id -u)" == "0" ]]; then
  chown -R "${SERVICE_UID}:${SERVICE_GID}" "$instance_dir"
  chown -R 70:70 "$instance_dir/db" 2>/dev/null || echo "[install] warning: could not chown Postgres data dir to uid 70" >&2
else
  if [[ "$SERVICE_UID" != "$(id -u)" || "$SERVICE_GID" != "$(id -g)" ]]; then
    echo "[install] non-root install requires SERVICE_UID/SERVICE_GID to match installer user. Current: $(id -u):$(id -g), configured: ${SERVICE_UID}:${SERVICE_GID}" >&2
    exit 1
  fi
  if command -v setfacl >/dev/null 2>&1; then
    setfacl -R -m u:70:rwX -m d:u:70:rwX "$instance_dir/db" 2>/dev/null || chmod -R a+rwX "$instance_dir/db"
  else
    chmod -R a+rwX "$instance_dir/db"
  fi
fi

if [[ ! -f "$master_key_file" ]]; then
  openssl rand -hex 32 >"$master_key_file"
  chmod 0400 "$master_key_file"
  echo "[install] generated master key: $master_key_file"
fi
if [[ "$(id -u)" == "0" ]]; then
  chown "${SERVICE_UID}:${SERVICE_GID}" "$master_key_file"
fi
chmod 0400 "$master_key_file"

# .version
ver="$(version_field version)"
git_commit="$(version_field gitCommit)"
write_version_file "$instance_dir" "$ver" "$git_commit"
echo "[install] wrote $instance_dir/.version (version=${ver:-unknown})"

# Seed sandbox version files (optional)
seed_instance_sandbox "$PKG_ROOT" "$instance_dir"

# Checksums + image load run CONCURRENTLY (task-55332474): hashing 5.3G was a
# ~26s serial preamble before an ~88s serial load. Semantics: verify-before-
# START is preserved (we abort before compose up on any mismatch); the old
# verify-before-LOAD is deliberately relaxed — in a from-scratch install a
# corrupt image that has been loaded is never run, and a bad tar fails its
# own 'docker load' anyway.
checksum_tmp="$(mktemp "${TMPDIR:-/tmp}/install-checksums.XXXXXX")"
checksum_pid=""
if [[ -f "$PKG_ROOT/checksums.sha256" ]]; then
  echo "[install] verifying release files (background) + loading images in parallel..."
  (cd "$PKG_ROOT" && sha256sum -c checksums.sha256) >"$checksum_tmp" 2>&1 &
  checksum_pid=$!
else
  echo "[install] loading images (no checksums file in package)..."
fi

parallel_docker_load "$PKG_ROOT/images" || die "docker load failed — see output above"

if [[ -n "$checksum_pid" ]]; then
  wait "$checksum_pid" || { cat "$checksum_tmp" >&2; rm -f "$checksum_tmp"; die "checksum verification failed"; }
  cat "$checksum_tmp"
fi
rm -f "$checksum_tmp"
validate_local_images

echo "[install] starting VulnHunter (project=$project_name, dir=$instance_dir)..."
if docker compose version >/dev/null 2>&1; then
  instance_compose "$instance_dir" "$project_name" up -d --pull never
else
  validate_local_images
  instance_compose "$instance_dir" "$project_name" up -d --no-build
fi

url="http://127.0.0.1:${web_port}/api/system/status"
for i in {1..60}; do
  if curl -fsS "$url" >/dev/null 2>&1; then
    echo "[install] service is ready"
    break
  fi
  if [[ "$i" == 60 ]]; then
    echo "[install] timed out waiting for $url" >&2
    instance_compose "$instance_dir" "$project_name" ps || true
    exit 1
  fi
  sleep 2
done

status_json="$(curl -fsS "$url")"
install_id="$(printf '%s' "$status_json" | sed -n 's/.*"installation_id":"\([^"]*\)".*/\1/p')"
[[ -n "$install_id" ]] || install_id="$(printf '%s' "$status_json" | sed -n 's/.*"machine_code":"\([^"]*\)".*/\1/p')"
now="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
youngflow="$(version_field youngflowVersion)"

manifest="$instance_dir/.vulnhunter-install.json"
cat >"${manifest}.tmp" <<JSON
{
  "schema_version": 2,
  "product": "vulnhunter",
  "layout": "self-contained-instance-dir",
  "install_dir": "$(json_escape "$instance_dir")",
  "package_dir_at_install": "$(json_escape "$PKG_ROOT")",
  "data_dir": "$(json_escape "$instance_dir")",
  "project_name": "$(json_escape "$project_name")",
  "edition": "$(json_escape "${EDITION:-community}")",
  "installed_at": "$now",
  "updated_at": "$now",
  "installation_id": "$(json_escape "$install_id")",
  "installed_version": {
    "version": "$(json_escape "$ver")",
    "git_commit": "$(json_escape "$git_commit")",
    "youngflow_version": "$(json_escape "$youngflow")"
  },
  "current_version": {
    "version": "$(json_escape "$ver")",
    "git_commit": "$(json_escape "$git_commit")",
    "youngflow_version": "$(json_escape "$youngflow")"
  },
  "compose": {
    "file": "docker-compose.yml",
    "project": "$(json_escape "$project_name")",
    "network": "vulnhunter-internal",
    "containers": ["vulnhunter-web", "vulnhunter-service", "vulnhunter-db", "vulnhunter-minio", "vulnhunter-admin-api", "vulnhunter-admin-web"]
  },
  "managed_files": [
    { "path": ".env", "kind": "config", "preserve": true, "secret_values": true },
    { "path": ".env.template", "kind": "env_template", "preserve": false, "secret_values": false },
    { "path": "docker-compose.yml", "kind": "compose", "preserve": false, "secret_values": false },
    { "path": ".version", "kind": "version", "preserve": false, "secret_values": false },
    { "path": ".secrets/license-public.pem", "kind": "license_public_key", "preserve": true, "secret_values": false },
    { "path": ".secrets/host-product-uuid", "kind": "host_machine_identity", "preserve": true, "secret_values": false },
    { "path": ".secrets/vulnhunter-master.key", "kind": "master_key", "preserve": true, "secret_values": true },
    { "path": ".install_id", "kind": "installation_id", "preserve": true, "secret_values": false }
  ],
  "managed_dirs": [
    { "path": "db", "kind": "postgres_data", "preserve": true },
    { "path": "minio", "kind": "object_storage", "preserve": true },
    { "path": "workspaces", "kind": "worker_workspaces", "preserve": true },
    { "path": "sandbox/secrets", "kind": "sandbox_secrets", "preserve": true }
  ],
  "release_images": {
    "service": "$(json_escape "${SERVICE_IMAGE:-}")",
    "web": "$(json_escape "${WEB_IMAGE:-}")",
    "worker": "$(json_escape "${WORKER_IMAGE:-}")"
  }
}
JSON
mv "${manifest}.tmp" "$manifest"
echo "[install] wrote install manifest: $manifest"

# Optional doctor from package (best-effort)
if [[ -x "$PKG_ROOT/doctor.sh" ]]; then
  echo "[install] running doctor..."
  if INSTANCE_DIR="$instance_dir" "$PKG_ROOT/doctor.sh"; then
    echo "[install] doctor ok"
  else
    echo "[install] warning: doctor reported issues (stack is up; review output above)" >&2
  fi
fi

host_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
admin_addr="${ADMIN_LISTEN_ADDR:-0.0.0.0}"
admin_port="${ADMIN_PORT:-23001}"

echo ""
echo "VulnHunter installed (self-contained instance)."
echo "INSTANCE_DIR: $instance_dir"
echo "PROJECT_NAME: $project_name"
echo "URL: http://${host_ip:-127.0.0.1}:${web_port}/"
echo "Local URL: http://127.0.0.1:${web_port}/"
echo "Admin console: http://${admin_addr}:${admin_port}/admin  (default all-interfaces; production pin: ADMIN_LISTEN_ADDR=127.0.0.1 or ssh -L)"
echo "System admin: ${VULNHUNTER_ADMIN_EMAIL:-admin@vulnhunter.local}  (password in $instance_dir/.env — VULNHUNTER_ADMIN_PASSWORD; account is protected: cannot be disabled/deleted)"
[[ -n "$install_id" ]] && echo "Machine code: $install_id"
echo ""
echo "Day-2 commands (package may be deleted):"
echo "  docker compose -p $project_name --env-file $instance_dir/.env -f $instance_dir/docker-compose.yml ps"
echo "  docker compose -p $project_name --env-file $instance_dir/.env -f $instance_dir/docker-compose.yml up -d"
echo ""
echo "The release package directory is no longer required for runtime:"
echo "  $PKG_ROOT"
echo "You may delete it after taking a backup of $instance_dir if desired."
echo ""
# Remote SandboxPlane without a bastion identity: warn loudly NOW, not when
# the first dynamic task silently degrades (2026-08-04 incident).
if grep -qE '^SANDBOX_SSH_BASTION=.+' "$instance_dir/.env" 2>/dev/null \
  && ! grep -qE '^SANDBOX_SSH_BASTION_IDENTITY=.+' "$instance_dir/.env" 2>/dev/null; then
  echo ""
  echo "------------------------------------------------------------------"
  echo " WARNING: remote SandboxPlane configured without bastion identity"
  echo " Dynamic verification will NOT work until you set"
  echo "   SANDBOX_SSH_BASTION_IDENTITY=<private key file>  in .env"
  echo " and restart the stack."
  echo "------------------------------------------------------------------"
  echo ""
fi

echo "Next: open /activate, import license, bootstrap admin, configure model credential."
if [[ -d "$PKG_ROOT/sandbox" ]]; then
  echo "Optional dynamic sandboxes:"
  echo "  PLATFORM_DIR=$instance_dir $PKG_ROOT/sandbox/install.sh"
  echo "  (uses instance .env; version files seeded under $instance_dir/sandbox/)"
fi
