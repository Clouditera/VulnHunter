#!/usr/bin/env bash
# Regression test for HALL-12 review blocker 2: the compose interpolation for
# VULNHUNTER_DMI_PRODUCT_UUID_PATH must distinguish unset (apply default) from
# explicitly empty (disable DMI binding) — `${VAR-default}`, not `${VAR:-default}`.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT/docker-compose.yml"

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

# Extract the resolved container-side value from `docker compose config`
# (2 occurrences: service + admin-api; sort -u collapses them to one line).
# --env-file /dev/null keeps the run hermetic regardless of a local deploy/.env.
extract_path() {
  sed -n 's/^ *VULNHUNTER_DMI_PRODUCT_UUID_PATH: *//p' | tr -d '"' | sort -u
}

if ! docker compose version >/dev/null 2>&1; then
  echo "[skip] docker compose v2 not available"
  exit 0
fi

echo "== dmi product uuid path interpolation =="

got="$(env -u VULNHUNTER_DMI_PRODUCT_UUID_PATH docker compose --env-file /dev/null -f "$COMPOSE_FILE" config 2>/dev/null | extract_path)"
assert_eq "unset applies the default" "$got" "/run/vulnhunter/host/product_uuid"

got="$(VULNHUNTER_DMI_PRODUCT_UUID_PATH='' docker compose --env-file /dev/null -f "$COMPOSE_FILE" config 2>/dev/null | extract_path)"
assert_eq "explicit empty disables DMI binding (no default applied)" "$got" ""

got="$(VULNHUNTER_DMI_PRODUCT_UUID_PATH='/custom/product_uuid' docker compose --env-file /dev/null -f "$COMPOSE_FILE" config 2>/dev/null | extract_path)"
assert_eq "custom path is honored" "$got" "/custom/product_uuid"

if (( fail )); then
  echo "FAILED" >&2
  exit 1
fi
echo "PASS"
