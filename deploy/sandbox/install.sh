#!/usr/bin/env bash
# SandboxPlane substack installer (same-host or --remote).
# Run from the release package root or from this sandbox/ directory.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SANDBOX_DIR="$SCRIPT_DIR"
# Prefer package root as platform root (parent of sandbox/)
PKG_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PLATFORM_DIR="${PLATFORM_DIR:-$PKG_ROOT}"

REMOTE=0
WITH_QEMU=0
for arg in "$@"; do
  case "$arg" in
    --remote) REMOTE=1 ;;
    --with-qemu) WITH_QEMU=1 ;;
    -h|--help)
      cat <<'EOF'
Usage: ./install.sh [--remote] [--with-qemu]

  (default)  Same-host: load images, start plane, join vulnhunter-internal,
             write SANDBOXPLANE_* into platform .env, recreate service, self-check.
  --remote   Remote host: load images, start plane, print token+URL for .env backfill.
  --with-qemu  Also load images-optional/ (requires /dev/kvm).
EOF
      exit 0
      ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

log() { printf '[sandbox-install] %s\n' "$*"; }
die() { printf '[sandbox-install] ERROR: %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "docker not found"
docker info >/dev/null 2>&1 || die "docker daemon not reachable"

if [[ "$WITH_QEMU" == "1" ]]; then
  [[ -e /dev/kvm ]] || die "/dev/kvm missing (required for --with-qemu)"
fi

[[ -f "$SANDBOX_DIR/docker-compose.yml" ]] || die "missing $SANDBOX_DIR/docker-compose.yml"
[[ -f "$SANDBOX_DIR/profiles.yaml" ]] || die "missing profiles.yaml"
[[ -d "$SANDBOX_DIR/images" ]] || die "missing images/ — was this release built with SANDBOX_PLANE_REF?"

load_tars() {
  local dir="$1"
  [[ -d "$dir" ]] || return 0
  local f
  shopt -s nullglob
  for f in "$dir"/*.tar; do
    log "docker load < $(basename "$f")"
    docker load -i "$f" >/dev/null
  done
  shopt -u nullglob
}

log "loading required images..."
load_tars "$SANDBOX_DIR/images"
if [[ "$WITH_QEMU" == "1" ]]; then
  log "loading optional QEMU images..."
  load_tars "$SANDBOX_DIR/images-optional"
fi

# Assert profile images exist locally
assert_profile_images() {
  local missing=0
  local img
  while IFS= read -r img; do
    [[ -n "$img" ]] || continue
    if ! docker image inspect "$img" >/dev/null 2>&1; then
      log "MISSING image referenced by profiles.yaml: $img"
      missing=1
    fi
  done < <(grep -E '^\s+image:\s+' "$SANDBOX_DIR/profiles.yaml" | sed -E 's/.*image:[[:space:]]*//' | tr -d '"' | tr -d "'")
  # service image from compose
  local svc
  svc=$(grep -E '^\s+image:\s+sandbox-plane/service' "$SANDBOX_DIR/docker-compose.yml" | head -1 | sed -E 's/.*image:[[:space:]]*//' | tr -d '"' | tr -d "'")
  if [[ -n "$svc" ]] && ! docker image inspect "$svc" >/dev/null 2>&1; then
    log "MISSING service image: $svc"
    missing=1
  fi
  [[ "$missing" == "0" ]] || die "profile/compose images missing after load (fail-closed)"
}
assert_profile_images

# Secrets (idempotent)
SECRETS="$SANDBOX_DIR/secrets"
mkdir -p "$SECRETS"
chmod 700 "$SECRETS"
TOKEN_FILE="$SECRETS/sandbox-plane-service-token.json"
ADMIN_FILE="$SECRETS/sandbox-plane-admin-credential.json"

gen_token_json() {
  local token
  token=$(openssl rand -hex 32)
  printf '{"token":"%s"}\n' "$token"
}

if [[ ! -f "$TOKEN_FILE" ]]; then
  log "generating service token"
  gen_token_json >"$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE"
else
  log "reusing existing service token"
fi
if [[ ! -f "$ADMIN_FILE" ]]; then
  log "generating admin credential placeholder"
  printf '{"username":"admin","password":"%s"}\n' "$(openssl rand -hex 16)" >"$ADMIN_FILE"
  chmod 600 "$ADMIN_FILE"
else
  log "reusing existing admin credential"
fi

TOKEN=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["token"])' "$TOKEN_FILE")

# Ensure config copies next to compose for volume mounts
cp -f "$SANDBOX_DIR/config.yaml" "$SANDBOX_DIR/config.yaml.bak" 2>/dev/null || true
# compose expects ./config.yaml and ./profiles.yaml relative to sandbox dir
[[ -f "$SANDBOX_DIR/config.yaml" ]]
[[ -f "$SANDBOX_DIR/profiles.yaml" ]]
mkdir -p "$SANDBOX_DIR/data"

log "starting sandbox-plane stack..."
(
  cd "$SANDBOX_DIR"
  docker compose up -d
)

# Wait health
log "waiting for plane health..."
ok=0
for i in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:28090/livez" >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep 1
done
[[ "$ok" == "1" ]] || die "plane /livez not healthy within 60s"

if [[ "$REMOTE" == "1" ]]; then
  HOST_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
  HOST_IP=${HOST_IP:-<this-host-ip>}
  cat <<EOF

[sandbox-install] REMOTE mode complete.

  Plane URL : http://${HOST_IP}:28090
  Token     : ${TOKEN}

Backfill on the platform host .env:
  SANDBOXPLANE_BASE_URL=https://<tls-or-tunnel-endpoint>
  SANDBOXPLANE_TOKEN=${TOKEN}

Then recreate only the platform service container.
See docs/sandbox-install.md and the remote topology runbook for TLS + bastion.
EOF
  exit 0
fi

# Same-host wiring
PLATFORM_COMPOSE="${PLATFORM_DIR}/docker-compose.yml"
PLATFORM_ENV="${PLATFORM_DIR}/.env"
[[ -f "$PLATFORM_COMPOSE" ]] || die "platform compose not found at $PLATFORM_COMPOSE (install platform first)"
[[ -f "$PLATFORM_ENV" ]] || die "platform .env not found at $PLATFORM_ENV (install platform first)"

# Join vulnhunter-internal
if docker network inspect vulnhunter-internal >/dev/null 2>&1; then
  if docker network inspect vulnhunter-internal --format '{{json .Containers}}' | grep -q sandbox-plane; then
    log "plane already on vulnhunter-internal"
  else
    log "connecting sandbox-plane to vulnhunter-internal (alias sandbox-plane)"
    docker network connect --alias sandbox-plane vulnhunter-internal sandbox-plane \
      || docker network connect vulnhunter-internal sandbox-plane || die "network connect failed"
  fi
else
  die "docker network vulnhunter-internal not found — start platform stack first"
fi

# Write .env keys
upsert_env() {
  local key="$1" val="$2" file="$3"
  if grep -qE "^${key}=" "$file" 2>/dev/null; then
    local cur
    cur=$(grep -E "^${key}=" "$file" | head -1 | cut -d= -f2-)
    if [[ "$cur" == "$val" ]]; then
      log ".env $key already set"
      return 0
    fi
    cp -a "$file" "${file}.bak.sandbox.$(date +%s)"
    if [[ "$(uname)" == Darwin ]]; then
      sed -i '' -E "s|^${key}=.*|${key}=${val}|" "$file"
    else
      sed -i -E "s|^${key}=.*|${key}=${val}|" "$file"
    fi
    log "updated .env $key (backup created)"
  else
    printf '\n%s=%s\n' "$key" "$val" >>"$file"
    log "appended .env $key"
  fi
}

upsert_env SANDBOXPLANE_BASE_URL "http://sandbox-plane:28090" "$PLATFORM_ENV"
upsert_env SANDBOXPLANE_TOKEN "$TOKEN" "$PLATFORM_ENV"

log "recreating platform service only (env pickup)..."
(
  cd "$PLATFORM_DIR"
  docker compose up -d service
)

# Self-check list types
log "self-check: list sandbox types..."
resp=$(curl -fsS -H "Authorization: Bearer ${TOKEN}" "http://127.0.0.1:28090/profiles" || true)
if [[ -z "$resp" ]]; then
  die "failed to GET /profiles"
fi
if echo "$resp" | grep -q '"status":"available"\|"status": "available"'; then
  log "SUCCESS: at least one profile available=true"
else
  log "response: $resp"
  die "no profile with available=true — check images/sysbox/kvm"
fi

log "done. Dynamic verification should now be enabled on the platform."
