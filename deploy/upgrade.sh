#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
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
docker compose up -d
"$ROOT/doctor.sh"
