#!/usr/bin/env bash
# SandboxPlane substack installer (same-host or --remote).
# Run from the release package root or from this sandbox/ directory.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Image/tarball source: always the directory that holds this script (package or seeded copy).
SANDBOX_DIR="$SCRIPT_DIR"
# Prefer package root as platform root (parent of sandbox/) unless PLATFORM_DIR/INSTANCE_DIR set.
PKG_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# Self-contained layout: PLATFORM_DIR = INSTANCE_DIR (has .env + compose + optional sandbox/).
if [[ -n "${PLATFORM_DIR:-}" ]]; then
  :
elif [[ -n "${INSTANCE_DIR:-}" && -f "${INSTANCE_DIR}/.env" ]]; then
  PLATFORM_DIR="$INSTANCE_DIR"
elif [[ -f "$PKG_ROOT/.env" && -f "$PKG_ROOT/docker-compose.yml" ]]; then
  PLATFORM_DIR="$PKG_ROOT"
elif [[ -f "$SCRIPT_DIR/../.env" ]]; then
  PLATFORM_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
else
  PLATFORM_DIR="$PKG_ROOT"
fi

# Instance-owned secrets/compose when PLATFORM_DIR/sandbox exists (seeded by install v2).
INSTANCE_SANDBOX=""
if [[ -d "$PLATFORM_DIR/sandbox" ]]; then
  INSTANCE_SANDBOX="$PLATFORM_DIR/sandbox"
  # Prefer instance compose/config if present; still load images from SANDBOX_DIR (may be same).
  for _f in docker-compose.yml config.yaml profiles.yaml; do
    if [[ ! -f "$INSTANCE_SANDBOX/$_f" && -f "$SANDBOX_DIR/$_f" ]]; then
      cp -f "$SANDBOX_DIR/$_f" "$INSTANCE_SANDBOX/$_f"
    fi
  done
fi
COMPOSE_DIR="${INSTANCE_SANDBOX:-$SANDBOX_DIR}"

REMOTE=0
WITH_QEMU=0
for arg in "$@"; do
  case "$arg" in
    --remote) REMOTE=1 ;;
    --with-qemu) WITH_QEMU=1 ;;
    -h|--help)
      cat <<'EOF'
Usage: ./install.sh [--remote]

  (default)  Same-host: load ALL profile images (incl. qemu), start plane, join network,
             write SANDBOXPLANE_* into platform .env, recreate service, self-check.
             Without /dev/kvm, qemu profiles stay unavailable (not an install failure).
  --remote   Remote host: load images, start plane, print token+URL for .env backfill.
  --with-qemu  Accepted for compatibility; full pack is always loaded.
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

# Version preflight: Docker Engine >= 20.10 and Compose v2 plugin (HALL-8).
# common.sh lives next to sandbox/ in the release package (lib/common.sh).
# shellcheck source=../lib/common.sh
source "$SCRIPT_DIR/../lib/common.sh"
check_docker_requirements

# /dev/kvm optional: without it qemu profiles stay unavailable (plane reports truthfully)
if [[ ! -e /dev/kvm ]]; then
  log "note: /dev/kvm not present — qemu profiles will be unavailable"
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

log "loading all sandbox images (full pack)..."
load_tars "$SANDBOX_DIR/images"
load_tars "$SANDBOX_DIR/images-optional"

# Assert every profile image exists (qemu image must be present; runtime needs /dev/kvm for available=true)
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
  local svc
  svc=$(grep -E '^\s+image:\s+sandbox-plane/service' "$SANDBOX_DIR/docker-compose.yml" | head -1 | sed -E 's/.*image:[[:space:]]*//' | tr -d '"' | tr -d "'")
  if [[ -n "$svc" ]] && ! docker image inspect "$svc" >/dev/null 2>&1; then
    log "MISSING service image: $svc"
    missing=1
  fi
  [[ "$missing" == "0" ]] || die "profile/compose images missing after load (fail-closed)"
}
assert_profile_images

# Secrets (idempotent) — plane TokenFileProvider schema: version+service_id+token
# Prefer instance-owned secrets path so the release package can be deleted.
SECRETS="${INSTANCE_SANDBOX:-$SANDBOX_DIR}/secrets"
mkdir -p "$SECRETS"
chmod 700 "$SECRETS"
TOKEN_FILE="$SECRETS/sandbox-plane-service-token.json"
ADMIN_FILE="$SECRETS/sandbox-plane-admin-credential.json"

gen_token_json() {
  local token
  token=$(openssl rand -hex 32)
  printf '{"version":1,"service_id":"vulnhunter","token":"%s"}\n' "$token"
}

# Admin credential: {version:1, password_hash: $scrypt$...} via plane-compatible scrypt
gen_admin_json() {
  # Host may lack node/python — run scrypt inside the plane service image we just loaded.
  local svc_img
  svc_img=$(grep -E '^\s+image:\s+sandbox-plane/service' "$COMPOSE_DIR/docker-compose.yml" | head -1 | sed -E 's/.*image:[[:space:]]*//' | tr -d '"' | tr -d "'")
  [[ -n "$svc_img" ]] || die "cannot parse plane service image for admin credential generation"
  docker run --rm --entrypoint node "$svc_img" -e '
const { randomBytes, scrypt } = require("node:crypto");
const { promisify } = require("node:util");
const scryptAsync = promisify(scrypt);
(async () => {
  const password = randomBytes(16).toString("hex");
  const salt = randomBytes(16);
  const digest = await scryptAsync(password, salt, 32, { N: 2**15, r: 8, p: 1, maxmem: 128*1024*1024 });
  const hash = `$scrypt$ln=15,r=8,p=1$${salt.toString("base64url")}$${digest.toString("base64url")}`;
  process.stdout.write(JSON.stringify({ version: 1, password_hash: hash }) + "\n");
})().catch((e) => { console.error(e); process.exit(1); });
'
}

if [[ ! -f "$TOKEN_FILE" ]]; then
  log "generating service token (version/service_id/token)"
  gen_token_json >"$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE"
else
  # migrate legacy token files via plane image node (no host python/node)
  local_svc=$(grep -E '^\s+image:\s+sandbox-plane/service' "$COMPOSE_DIR/docker-compose.yml" | head -1 | sed -E 's/.*image:[[:space:]]*//' | tr -d '"' | tr -d "'")
  if ! docker run --rm -v "$TOKEN_FILE:/token.json:ro" --entrypoint node "$local_svc" -e 'const d=JSON.parse(require("fs").readFileSync("/token.json","utf8")); if(!(d.version===1&&d.service_id&&String(d.token||"").length>=32)) process.exit(2)' 2>/dev/null; then
    log "upgrading legacy token file schema"
    tok=$(docker run --rm -v "$TOKEN_FILE:/token.json:ro" --entrypoint node "$local_svc" -e 'try{process.stdout.write(String(JSON.parse(require("fs").readFileSync("/token.json","utf8")).token||""))}catch{process.stdout.write("")}' 2>/dev/null || true)
    if [[ ${#tok} -lt 32 ]]; then tok=$(openssl rand -hex 32); fi
    printf '{"version":1,"service_id":"vulnhunter","token":"%s"}\n' "$tok" >"$TOKEN_FILE"
    chmod 600 "$TOKEN_FILE"
  else
    log "reusing existing service token"
  fi
fi

if [[ ! -f "$ADMIN_FILE" ]]; then
  log "generating admin credential (scrypt password_hash)"
  gen_admin_json >"$ADMIN_FILE"
  chmod 600 "$ADMIN_FILE"
else
  PLANE_SERVICE_IMAGE=${PLANE_SERVICE_IMAGE:-$(grep -E '^\s+image:\s+sandbox-plane/service' "$COMPOSE_DIR/docker-compose.yml" | head -1 | sed -E 's/.*image:[[:space:]]*//' | tr -d '"' | tr -d "'")}
  if ! docker run --rm -v "$ADMIN_FILE:/admin.json:ro" --entrypoint node "$PLANE_SERVICE_IMAGE" -e 'const d=JSON.parse(require("fs").readFileSync("/admin.json","utf8")); if(!(d.version===1&&d.password_hash)) process.exit(2)' 2>/dev/null; then
    log "upgrading legacy admin credential file"
    gen_admin_json >"$ADMIN_FILE"
    chmod 600 "$ADMIN_FILE"
  else
    log "reusing existing admin credential"
  fi
fi

PLANE_SERVICE_IMAGE=$(grep -E '^\s+image:\s+sandbox-plane/service' "$COMPOSE_DIR/docker-compose.yml" | head -1 | sed -E 's/.*image:[[:space:]]*//' | tr -d '"' | tr -d "'")
TOKEN=$(docker run --rm -v "$TOKEN_FILE:/token.json:ro" --entrypoint node "$PLANE_SERVICE_IMAGE" -e 'console.log(JSON.parse(require("fs").readFileSync("/token.json","utf8")).token)')

# Ensure config copies next to compose for volume mounts
cp -f "$COMPOSE_DIR/config.yaml" "$COMPOSE_DIR/config.yaml.bak" 2>/dev/null || true
# compose expects ./config.yaml and ./profiles.yaml relative to compose dir
[[ -f "$COMPOSE_DIR/config.yaml" ]]
[[ -f "$COMPOSE_DIR/profiles.yaml" ]]
mkdir -p "$COMPOSE_DIR/data"
# Plane compose typically bind-mounts ./secrets — ensure it sees instance secrets
if [[ -n "$INSTANCE_SANDBOX" && "$COMPOSE_DIR" == "$INSTANCE_SANDBOX" ]]; then
  mkdir -p "$COMPOSE_DIR/secrets"
fi

log "starting sandbox-plane stack (compose_dir=$COMPOSE_DIR)..."
(
  cd "$COMPOSE_DIR"
  unset COMPOSE_PROJECT_NAME || true
  export COMPOSE_PROJECT_NAME=sandbox-plane
  docker compose -p sandbox-plane up -d
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

log "recreating platform service only (env pickup, --no-deps)..."
# Detect compose project from running service container to avoid name collisions.
PROJECT_NAME="${COMPOSE_PROJECT_NAME:-}"
if [[ -z "$PROJECT_NAME" ]]; then
  PROJECT_NAME=$(docker inspect vulnhunter-service --format '{{index .Config.Labels "com.docker.compose.project"}}' 2>/dev/null || true)
fi
if [[ -z "$PROJECT_NAME" ]]; then
  PROJECT_NAME=$(basename "$PLATFORM_DIR" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]//g')
  log "compose project not labeled; fallback name=$PROJECT_NAME"
fi
(
  cd "$PLATFORM_DIR"
  export COMPOSE_PROJECT_NAME="$PROJECT_NAME"
  # --no-deps: never recreate db/minio/web when only service env changed
  docker compose up -d --no-deps --force-recreate service
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
