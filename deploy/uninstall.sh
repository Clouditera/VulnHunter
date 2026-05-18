#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
PURGE=0
[[ "${1:-}" == "--purge" ]] && PURGE=1
if [[ "$PURGE" == 1 ]]; then
  echo "[uninstall] stopping and removing containers/volumes"
  docker compose down -v
  echo "[uninstall] data dir is not removed automatically; remove it manually after backup if desired."
else
  echo "[uninstall] stopping containers (data preserved). Use --purge to remove compose volumes."
  docker compose down
fi
