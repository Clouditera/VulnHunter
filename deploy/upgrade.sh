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
  [[ ! -d "$1" ]] || [[ -z "$(find "$1" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]]
}
prepare_data_dirs() {
  DATA_DIR="${DATA_DIR:-/opt/vulnhunt/data}"
  SERVICE_UID="${SERVICE_UID:-1001}"
  SERVICE_GID="${SERVICE_GID:-1001}"
  mkdir -p "$DATA_DIR/db" "$DATA_DIR/minio"
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
  compose stop "$service" >/dev/null 2>&1 || true
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
prepare_data_dirs
migrate_container_data vulnhunt-db /var/lib/postgresql/data "${DATA_DIR:-/opt/vulnhunt/data}/db" db
migrate_container_data vulnhunt-minio /data "${DATA_DIR:-/opt/vulnhunt/data}/minio" minio
prepare_data_dirs
if [[ -d images ]]; then
  for img in images/*.tar; do
    [[ -f "$img" ]] || continue
    echo "[upgrade] loading image $img"
    docker load -i "$img"
  done
fi
compose up -d
"$ROOT/doctor.sh"
