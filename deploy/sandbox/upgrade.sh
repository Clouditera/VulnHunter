#!/usr/bin/env bash
# Upgrade SandboxPlane substack only — never touches platform containers/.env.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SANDBOX_DIR="$SCRIPT_DIR"
WITH_QEMU=0
for arg in "$@"; do
  case "$arg" in
    --with-qemu) WITH_QEMU=1 ;;
    -h|--help) echo "Usage: ./upgrade.sh [--with-qemu]"; exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

log() { printf '[sandbox-upgrade] %s\n' "$*"; }
die() { printf '[sandbox-upgrade] ERROR: %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "docker not found"
[[ -d "$SANDBOX_DIR/images" ]] || die "missing images/"

load_tars() {
  local dir="$1"
  [[ -d "$dir" ]] || return 0
  shopt -s nullglob
  local f
  for f in "$dir"/*.tar; do
    log "docker load < $(basename "$f")"
    docker load -i "$f" >/dev/null
  done
  shopt -u nullglob
}

log "loading images..."
load_tars "$SANDBOX_DIR/images"
[[ "$WITH_QEMU" == "1" ]] && load_tars "$SANDBOX_DIR/images-optional"

# secrets must already exist (install created them)
TOKEN_FILE="$SANDBOX_DIR/secrets/sandbox-plane-service-token.json"
[[ -f "$TOKEN_FILE" ]] || die "missing secrets/ — run install.sh first (upgrade never regenerates tokens)"

PLANE_SERVICE_IMAGE=$(grep -E '^\s+image:\s+sandbox-plane/service' "$SANDBOX_DIR/docker-compose.yml" | head -1 | sed -E 's/.*image:[[:space:]]*//' | tr -d '"' | tr -d "'")
TOKEN=$(docker run --rm -v "$TOKEN_FILE:/token.json:ro" --entrypoint node "$PLANE_SERVICE_IMAGE" -e 'console.log(JSON.parse(require("fs").readFileSync("/token.json","utf8")).token)')

log "recreating plane only..."
(
  cd "$SANDBOX_DIR"
  unset COMPOSE_PROJECT_NAME || true
  export COMPOSE_PROJECT_NAME=sandbox-plane
  docker compose -p sandbox-plane up -d
)

ok=0
for i in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:28090/livez" >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
[[ "$ok" == "1" ]] || die "plane not healthy after upgrade"

resp=$(curl -fsS -H "Authorization: Bearer ${TOKEN}" "http://127.0.0.1:28090/profiles" || true)
if echo "$resp" | grep -q '"status":"available"\|"status": "available"'; then
  log "SUCCESS: plane upgraded; profiles available"
else
  log "response: $resp"
  die "no available profile after upgrade"
fi

log "platform side untouched (no .env / container changes)."
