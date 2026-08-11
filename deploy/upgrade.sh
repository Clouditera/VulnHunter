#!/usr/bin/env bash
# Platform upgrade only. Does NOT manage sandbox/ (SandboxPlane substack):
# use ./sandbox/upgrade.sh for plane lifecycle. Keys SANDBOXPLANE_* are left intact.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$ROOT/lib/common.sh"
cd "$ROOT"
version_field() {
  local key="$1"
  [[ -f VERSION.json ]] || return 0
  sed -n "s/.*\"$key\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" VERSION.json | head -n 1
}
env_value() {
  local key="$1" file="${2:-.env}"
  grep -E "^${key}=" "$file" 2>/dev/null | tail -n 1 | cut -d= -f2-
}
set_env_key() {
  local key="$1" value="$2"
  local env_file
  env_file="$(readlink -f .env)"
  if grep -qE "^${key}=" "$env_file"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$env_file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$env_file"
  fi
  export "$key=$value"
}
compose_up_detached() {
  if docker compose version >/dev/null 2>&1; then
    docker compose up -d --pull never
  elif command -v docker-compose >/dev/null 2>&1; then
    validate_local_images
    docker-compose up -d --no-build
  else
    echo "[upgrade] Docker Compose is required: install Docker Compose v2 ('docker compose') or legacy docker-compose" >&2
    return 127
  fi
}
add_missing_env_from_example() {
  [[ -f .env.example ]] || return 0
  while IFS= read -r line; do
    [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] || continue
    local key="${line%%=*}"
    if ! grep -qE "^${key}=" .env; then
      printf '%s\n' "$line" >> .env
      export "$line"
      echo "[upgrade] added missing env key: $key"
    fi
  done < .env.example
}
mount_source() {
  docker inspect "$1" --format "{{range .Mounts}}{{if eq .Destination \"$2\"}}{{.Source}}{{end}}{{end}}" 2>/dev/null || true
}
dir_empty() {
  local dir="$1"
  [[ ! -d "$dir" ]] && return 0
  # Permission denied must be treated as non-empty/unknown, not empty.
  local probe
  if ! probe="$(find "$dir" -mindepth 1 -maxdepth 1 -print -quit 2>/tmp/va-upgrade-find.err)"; then
    echo "[upgrade] cannot fully inspect $dir; treating as non-empty to avoid data loss" >&2
    return 1
  fi
  [[ -z "$probe" ]]
}
legacy_volume_candidates() {
  local suffix="$1"
  # Accept both pre-rename (vulnagent-*) and post-rename (vulnhunter-*) volume names.
  docker volume ls --format '{{.Name}}' | grep -E "(^|_)vuln(agent|hunter)-${suffix}$" || true
}
migrate_volume_data() {
  local volume="$1" target="$2" service="$3"
  echo "[upgrade] migrating $service data from legacy volume $volume to $target"
  docker stop vulnhunter-service vulnhunter-web vulnagent-service vulnagent-web >/dev/null 2>&1 || true
  if ! docker run --rm -v "$volume:/from:ro" -v "$target:/to" "${POSTGRES_IMAGE:-postgres:16-alpine}" sh -c 'cd /from && cp -a . /to/ && chmod -R u+rwX /to'; then
    echo "[upgrade] failed to migrate $service data from volume $volume; aborting to avoid empty data startup" >&2
    exit 1
  fi
}
protect_or_migrate_legacy_volume() {
  local suffix="$1" target="$2" service="$3"
  dir_empty "$target" || return 0
  local candidates=()
  while IFS= read -r volume; do
    [[ -n "$volume" ]] && candidates+=("$volume")
  done < <(legacy_volume_candidates "$suffix")
  if (( ${#candidates[@]} == 0 )); then
    return 0
  fi
  if (( ${#candidates[@]} == 1 )); then
    migrate_volume_data "${candidates[0]}" "$target" "$service"
    return 0
  fi
  echo "[upgrade] found multiple legacy $service volumes while $target is empty; refusing to start with empty data." >&2
  printf '[upgrade] candidate volume: %s\n' "${candidates[@]}" >&2
  echo "[upgrade] migrate the correct volume manually or remove stale candidates, then retry." >&2
  exit 1
}
postgres_dir_rw() {
  docker run --rm --user 70:70 -v "$DATA_DIR/db:/var/lib/postgresql/data" "${POSTGRES_IMAGE:-postgres:16-alpine}" sh -c 'test -r /var/lib/postgresql/data && touch /var/lib/postgresql/data/.perm-test && rm /var/lib/postgresql/data/.perm-test' >/dev/null 2>&1
}
prepare_data_dirs() {
  DATA_DIR="${DATA_DIR:-/opt/vulnhunter/data}"
  SERVICE_UID="${SERVICE_UID:-1001}"
  SERVICE_GID="${SERVICE_GID:-1001}"
  mkdir -p "$DATA_DIR/db" "$DATA_DIR/minio"
  if postgres_dir_rw; then
    chmod u+rwx "$DATA_DIR/minio" 2>/dev/null || true
    return 0
  fi
  if [[ "$(id -u)" == "0" ]]; then
    chown -R "${SERVICE_UID}:${SERVICE_GID}" "$DATA_DIR" 2>/dev/null || true
    chown -R 70:70 "$DATA_DIR/db" 2>/dev/null || echo "[upgrade] warning: could not chown Postgres data dir to uid 70" >&2
  else
    if command -v setfacl >/dev/null 2>&1; then
      setfacl -R -m u:70:rwX -m d:u:70:rwX "$DATA_DIR/db" 2>/dev/null || chmod -R a+rwX "$DATA_DIR/db"
    else
      chmod -R a+rwX "$DATA_DIR/db"
    fi
  fi
  chmod u+rwx "$DATA_DIR/minio" 2>/dev/null || true
}
sync_release_env() {
  [[ -f .env && -f .env.example ]] || return 0
  for key in SERVICE_IMAGE WEB_IMAGE WORKER_IMAGE; do
    local value
    value="$(env_value "$key" .env.example)"
    [[ -n "$value" ]] || continue
    set_env_key "$key" "$value"
    echo "[upgrade] synced release image key: $key=$value"
  done

  # EDITION is a user choice on top of the package flavor (enterprise pack +
  # EDITION=saas = SaaS). Only backfill the package default when the user .env
  # has no EDITION yet — never overwrite an existing value (fish 2026-08-09,
  # task-09560333: 31.106 saas→enterprise silent flip on 2.3.5→2.3.6).
  local edition pkg_edition
  edition="$(env_value EDITION .env)"
  pkg_edition="$(env_value EDITION .env.example)"
  if [[ -z "$edition" && "$pkg_edition" == "enterprise" ]]; then
    set_env_key EDITION enterprise
    echo "[upgrade] backfilled missing EDITION=enterprise"
  elif [[ -n "$edition" ]]; then
    echo "[upgrade] kept user EDITION=$edition"
  fi
  # License public-key paths are package-owned fixed locations (not a user
  # choice) — keep syncing them whenever the package is enterprise-flavored.
  if [[ "$pkg_edition" == "enterprise" ]]; then
    local license_key_file license_key_container
    license_key_file="$(env_value LICENSE_PUBLIC_KEY_FILE .env.example)"
    license_key_container="$(env_value VULNHUNTER_LICENSE_PUBLIC_KEY_FILE .env.example)"
    [[ -n "$license_key_file" ]] && set_env_key LICENSE_PUBLIC_KEY_FILE "$license_key_file"
    [[ -n "$license_key_container" ]] && set_env_key VULNHUNTER_LICENSE_PUBLIC_KEY_FILE "$license_key_container"
  fi

  add_missing_env_from_example

  ensure_system_admin_env
}

# Self-contained instance upgrade entry: when the package dir is pristine (no .env),
# delegate to the instance upgrade path (batch 2). INSTANCE_DIR via --dir/env/default.
INSTANCE_DIR_ARG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) INSTANCE_DIR_ARG="${2:-}"; shift 2 || true ;;
    --dir=*) INSTANCE_DIR_ARG="${1#*=}"; shift ;;
    --force) FORCE=1; shift ;;
    --with-running) WITH_RUNNING=1; shift ;;
    *) echo "[upgrade] unknown arg: $1" >&2; exit 2 ;;
  esac
done

validate_upgrade_preconditions() {
  if [[ ! -f .env ]]; then
    local instance_dir="${INSTANCE_DIR_ARG:-${INSTANCE_DIR:-${DATA_DIR:-/opt/vulnhunter/data}}}"
    if [[ -f "$instance_dir/.version" ]]; then
      echo "[upgrade] self-contained instance detected at $instance_dir — instance upgrade mode"
      # shellcheck source=lib/instance-dir.sh
      source "$ROOT/lib/instance-dir.sh"
      # shellcheck source=lib/instance-upgrade.sh
      source "$ROOT/lib/instance-upgrade.sh"
      run_instance_upgrade "$ROOT" "$instance_dir"
      exit $?
    fi
    echo "[upgrade] no .env found; upgrade.sh is only for existing installations." >&2
    echo "[upgrade] For a clean first install, run ./install.sh. If this is an old install, restore .env from backup before upgrading." >&2
    exit 1
  fi
  # Quiet window: refuse while any managed worker (legacy va-* or new vh-*) is running.
  # Shared with the rename migration gate so both old and new installs are covered.
  # shellcheck disable=SC1091
  source "$ROOT/lib/rename-migrate.sh"
  rename_quiet_window_gate || exit 1
}
validate_enterprise_assets() {
  if [[ "${EDITION:-}" == "enterprise" ]]; then
    local public_key_path="${LICENSE_PUBLIC_KEY_FILE:-./.secrets/license-public.pem}"
    if [[ ! -s "$public_key_path" ]]; then
      echo "[upgrade] enterprise release requires license public key: $public_key_path" >&2
      exit 1
    fi
  fi
}
write_install_manifest() {
  local now version git_commit youngflow install_id installed_at installed_version installed_commit installed_youngflow tmp
  now="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
  version="$(version_field version)"
  git_commit="$(version_field gitCommit)"
  youngflow="$(version_field youngflowVersion)"
  install_id=""
  [[ -f "${DATA_DIR:-/opt/vulnhunter/data}/.install_id" ]] && install_id="$(cat "${DATA_DIR:-/opt/vulnhunter/data}/.install_id" 2>/dev/null || true)"
  installed_at="$now"
  installed_version="$version"
  installed_commit="$git_commit"
  installed_youngflow="$youngflow"
  local manifest=".vulnhunter-install.json"
  [[ -f "$manifest" ]] || manifest=".vulnagent-install.json"
  if [[ -f "$manifest" ]]; then
    installed_at="$(sed -n 's/.*"installed_at"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$manifest" | head -n 1)"
    installed_version="$(sed -n '/"installed_version"/,/}/s/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$manifest" | head -n 1)"
    installed_commit="$(sed -n '/"installed_version"/,/}/s/.*"git_commit"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$manifest" | head -n 1)"
    installed_youngflow="$(sed -n '/"installed_version"/,/}/s/.*"youngflow_version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$manifest" | head -n 1)"
  fi
  [[ -n "$installed_at" ]] || installed_at="$now"
  [[ -n "$installed_version" ]] || installed_version="$version"
  [[ -n "$installed_commit" ]] || installed_commit="$git_commit"
  [[ -n "$installed_youngflow" ]] || installed_youngflow="$youngflow"
  tmp=".vulnhunter-install.json.tmp"
  cat > "$tmp" << JSON
{
  "schema_version": 1,
  "product": "vulnhunter",
  "install_dir": "$(json_escape "$ROOT")",
  "data_dir": "$(json_escape "${DATA_DIR:-/opt/vulnhunter/data}")",
  "edition": "$(json_escape "${EDITION:-community}")",
  "installed_at": "$(json_escape "$installed_at")",
  "updated_at": "$now",
  "installation_id": "$(json_escape "$install_id")",
  "installed_version": {
    "version": "$(json_escape "$installed_version")",
    "git_commit": "$(json_escape "$installed_commit")",
    "youngflow_version": "$(json_escape "$installed_youngflow")"
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
  }
}
JSON
  mv "$tmp" .vulnhunter-install.json
  echo "[upgrade] updated install manifest: .vulnhunter-install.json"
}

migrate_container_data() {
  local container="$1" dest="$2" target="$3" service="$4"
  local src; src="$(mount_source "$container" "$dest")"
  [[ -z "$src" || "$src" == "$target" ]] && return 0
  if ! dir_empty "$target"; then
    echo "[upgrade] $service target is non-empty and existing container uses another source: $src" >&2
    echo "[upgrade] refusing to overwrite $target; verify data manually before retrying." >&2
    exit 1
  fi
  echo "[upgrade] migrating $service data from $container:$dest to $target"
  docker stop vulnhunter-service vulnhunter-web vulnagent-service vulnagent-web >/dev/null 2>&1 || true
  docker stop "$container" >/dev/null 2>&1 || true
  if ! docker cp "$container:$dest/." "$target/"; then
    echo "[upgrade] failed to migrate $service data; aborting to avoid empty data startup" >&2
    exit 1
  fi
}

validate_upgrade_preconditions
set -a
# shellcheck disable=SC1091
source .env
set +a
mkdir -p backups
stamp="$(date +%Y%m%d-%H%M%S)"
cp .env "backups/.env.$stamp"
[[ -d .secrets ]] && tar -czf "backups/secrets.$stamp.tar.gz" .secrets
[[ -f .vulnagent-install.json ]] && cp .vulnagent-install.json "backups/install-manifest.$stamp.json"
[[ -f .vulnhunter-install.json ]] && cp .vulnhunter-install.json "backups/install-manifest.$stamp.json"

# One-shot VulnAgent → VulnHunter rename migration (no-op when package or install
# does not need it). Stops old stack, moves DATA_DIR, renames DB/role, copies
# MinIO bucket → artifact-store, rewrites .env, prepares vulnhunter-internal and
# reattaches SandboxPlane. See deploy/lib/rename-migrate.sh.
# shellcheck disable=SC1091
source "$ROOT/lib/rename-migrate.sh"
rename_run_migration

sync_release_env
set -a
# shellcheck disable=SC1091
source .env
set +a
validate_enterprise_assets
compose config >/dev/null
if [[ -d images ]]; then
  for img in images/*.tar; do
    [[ -f "$img" ]] || continue
    echo "[upgrade] loading image $img"
    docker load -i "$img"
  done
fi
validate_local_images
prepare_data_dirs

# One-time workdir rehome for worker de-identification (probe-gated, no-op on
# fresh installs; db/minio never touched). Same step runs on the
# self-contained instance path (lib/instance-upgrade.sh).
rehome_root_owned_workdirs "${DATA_DIR:-/opt/vulnhunter/data}" "${SERVICE_UID:-1001}" "${SERVICE_GID:-1001}" "${SERVICE_IMAGE:-vulnhunter-service:latest}"

# Dual-name: support both pre-rename (vulnagent-*) and post-rename (vulnhunter-*) containers.
migrate_container_data vulnagent-db /var/lib/postgresql/data "${DATA_DIR:-/opt/vulnagent/data}/db" db
migrate_container_data vulnhunter-db /var/lib/postgresql/data "${DATA_DIR:-/opt/vulnhunter/data}/db" db
migrate_container_data vulnagent-minio /data "${DATA_DIR:-/opt/vulnagent/data}/minio" minio
migrate_container_data vulnhunter-minio /data "${DATA_DIR:-/opt/vulnhunter/data}/minio" minio
protect_or_migrate_legacy_volume db "${DATA_DIR:-/opt/vulnagent/data}/db" db
protect_or_migrate_legacy_volume db "${DATA_DIR:-/opt/vulnhunter/data}/db" db
protect_or_migrate_legacy_volume minio "${DATA_DIR:-/opt/vulnagent/data}/minio" minio
protect_or_migrate_legacy_volume minio "${DATA_DIR:-/opt/vulnhunter/data}/minio" minio
prepare_data_dirs
docker rm -f \
  vulnagent-web vulnagent-service vulnagent-db vulnagent-minio \
  vulnhunter-web vulnhunter-service vulnhunter-admin-web vulnhunter-admin-api \
  vulnhunter-db vulnhunter-minio \
  >/dev/null 2>&1 || true
compose_up_detached
# Admin console default bind is 127.0.0.1 — warn operators after upgrade
admin_addr="${ADMIN_LISTEN_ADDR:-127.0.0.1}"
admin_port="${ADMIN_PORT:-23001}"
echo "[upgrade] WARNING: admin console listens on ${admin_addr}:${admin_port} (default localhost-only)."
echo "[upgrade] Remote admin: set ADMIN_LISTEN_ADDR=0.0.0.0 in .env, or ssh -L ${admin_port}:127.0.0.1:${admin_port}"
if [[ "$admin_addr" == "127.0.0.1" || "$admin_addr" == "localhost" ]]; then
  echo "[upgrade] Admin URL (on server): http://127.0.0.1:${admin_port}/admin"
fi
# Detach SandboxPlane from the legacy network once the new stack is up.
if declare -F rename_cleanup_old_network >/dev/null 2>&1; then
  rename_cleanup_old_network || true
fi
"$ROOT/doctor.sh"
write_install_manifest
