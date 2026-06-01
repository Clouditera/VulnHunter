#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose "$@"
  else
    echo "[upgrade] Docker Compose is required: install Docker Compose v2 ('docker compose') or legacy docker-compose" >&2
    return 127
  fi
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
  docker volume ls --format '{{.Name}}' | grep -E "(^|_)vulnagent-${suffix}$" || true
}
migrate_volume_data() {
  local volume="$1" target="$2" service="$3"
  echo "[upgrade] migrating $service data from legacy volume $volume to $target"
  docker stop vulnagent-service vulnagent-web >/dev/null 2>&1 || true
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
  DATA_DIR="${DATA_DIR:-/opt/vulnagent/data}"
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
sync_release_images() {
  [[ -f .env && -f .env.example ]] || return 0
  for key in SERVICE_IMAGE WEB_IMAGE WORKER_IMAGE EVAL_WORKER_IMAGE; do
    local value
    value="$(grep -E "^${key}=" .env.example | tail -n 1 | cut -d= -f2-)"
    [[ -n "$value" ]] || continue
    if grep -qE "^${key}=" .env; then
      sed -i "s|^${key}=.*|${key}=${value}|" .env
    else
      printf '%s=%s\n' "$key" "$value" >> .env
    fi
    export "$key=$value"
  done
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
  docker stop vulnagent-service vulnagent-web >/dev/null 2>&1 || true
  docker stop "$container" >/dev/null 2>&1 || true
  if ! docker cp "$container:$dest/." "$target/"; then
    echo "[upgrade] failed to migrate $service data; aborting to avoid empty data startup" >&2
    exit 1
  fi
}

[[ -f .env ]] && set -a && source .env && set +a
mkdir -p backups
stamp="$(date +%Y%m%d-%H%M%S)"
[[ -f .env ]] && cp .env "backups/.env.$stamp"
[[ -d .secrets ]] && tar -czf "backups/secrets.$stamp.tar.gz" .secrets
sync_release_images
if [[ -d images ]]; then
  for img in images/*.tar; do
    [[ -f "$img" ]] || continue
    echo "[upgrade] loading image $img"
    docker load -i "$img"
  done
fi
prepare_data_dirs
migrate_container_data vulnagent-db /var/lib/postgresql/data "${DATA_DIR:-/opt/vulnagent/data}/db" db
migrate_container_data vulnagent-minio /data "${DATA_DIR:-/opt/vulnagent/data}/minio" minio
protect_or_migrate_legacy_volume db "${DATA_DIR:-/opt/vulnagent/data}/db" db
protect_or_migrate_legacy_volume minio "${DATA_DIR:-/opt/vulnagent/data}/minio" minio
prepare_data_dirs
docker rm -f vulnagent-web vulnagent-service vulnagent-db vulnagent-minio >/dev/null 2>&1 || true
compose up -d
"$ROOT/doctor.sh"
