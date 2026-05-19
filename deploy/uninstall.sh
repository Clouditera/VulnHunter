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
    echo "[uninstall] Docker Compose is required: install Docker Compose v2 ('docker compose') or legacy docker-compose" >&2
    return 127
  fi
}
PURGE=0
[[ "${1:-}" == "--purge" ]] && PURGE=1
if [[ "$PURGE" == 1 ]]; then
  echo "[uninstall] stopping and removing containers/volumes"
  compose down -v
  echo "[uninstall] data dir is not removed automatically; remove it manually after backup if desired."
else
  echo "[uninstall] stopping containers (data preserved). Use --purge to remove compose volumes."
  compose down
fi
