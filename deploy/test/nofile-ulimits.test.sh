#!/usr/bin/env bash
# Regression test for HALL-18 B1: deploy/docker-compose.yml must explicitly
# declare nofile ulimits (soft=hard=1048576) for the four app services
# (service, admin-api, web, admin-web) — instead of relying on docker-daemon
# defaults that vary between hosts (prod evidence: daemon default 524288,
# EMFILE at ~470k leaked fds). db/minio are third-party images whose fd
# profile is modest; they intentionally keep daemon defaults.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT/docker-compose.yml"

APP_SERVICES=(service admin-api web admin-web)

fail=0
assert_eq() {
  local name="$1" got="$2" want="$3"
  if [[ "$got" == "$want" ]]; then
    echo "[ok] $name"
  else
    echo "[fail] $name: got='$got' want='$want'" >&2
    fail=1
  fi
}

if ! docker compose version >/dev/null 2>&1; then
  echo "[skip] docker compose v2 not available"
  exit 0
fi

echo "== nofile ulimits explicit in compose (HALL-18 B1) =="

# Extract the resolved "soft:hard" pair for a service from `docker compose
# config`. Rendered shape (soft first, then hard):
#   ulimits:
#     nofile:
#       soft: 1048576
#       hard: 1048576
extract_nofile() {
  local service="$1"
  docker compose --env-file /dev/null -f "$COMPOSE_FILE" config 2>/dev/null \
    | awk -v svc="$service" '
        $0 == "  " svc ":" { in_svc = 1; next }
        in_svc && /^  [a-zA-Z0-9_-]+:$/ { exit }
        in_svc && /^    ulimits:/ { in_ul = 1; next }
        in_ul && /^      nofile:/ { in_nf = 1; next }
        in_nf && /^        soft:/ { soft = $2; next }
        in_nf && /^        hard:/ { print soft ":" $2; exit }
      '
}

for svc in "${APP_SERVICES[@]}"; do
  got="$(extract_nofile "$svc")"
  assert_eq "$svc nofile soft:hard = 1048576:1048576" "$got" "1048576:1048576"
done

# The raw compose file itself must carry the literal declarations (auditable
# without a working docker CLI): every app service contributes one nofile block.
declared="$(grep -cE '^\s+nofile:' "$COMPOSE_FILE")"
assert_eq "raw file: nofile blocks == ${#APP_SERVICES[@]} app services" "$declared" "${#APP_SERVICES[@]}"

if (( fail )); then exit 1; fi
echo "all checks passed"
