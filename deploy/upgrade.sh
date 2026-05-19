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
mkdir -p backups
stamp="$(date +%Y%m%d-%H%M%S)"
[[ -f .env ]] && cp .env "backups/.env.$stamp"
[[ -d .secrets ]] && tar -czf "backups/secrets.$stamp.tar.gz" .secrets
if [[ -d images ]]; then
  for img in images/*.tar; do
    [[ -f "$img" ]] || continue
    echo "[upgrade] loading image $img"
    docker load -i "$img"
  done
fi
compose up -d
"$ROOT/doctor.sh"
