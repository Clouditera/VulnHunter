#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/instance-dir.sh
[[ -f "$ROOT/lib/instance-dir.sh" ]] && source "$ROOT/lib/instance-dir.sh"

# Prefer self-contained instance: --dir / INSTANCE_DIR / DATA_DIR / package cwd
INSTANCE_DIR_OPT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) INSTANCE_DIR_OPT="${2:-}"; shift 2 || true ;;
    --dir=*) INSTANCE_DIR_OPT="${1#*=}"; shift ;;
    -h|--help)
      echo "Usage: ./doctor.sh [--dir INSTANCE_DIR]"; exit 0 ;;
    *) break ;;
  esac
done

INSTANCE_DIR="${INSTANCE_DIR_OPT:-${INSTANCE_DIR:-${DATA_DIR:-}}}"
if [[ -z "$INSTANCE_DIR" && -f "$ROOT/.env" && -f "$ROOT/docker-compose.yml" ]]; then
  # legacy / package-local layout
  cd "$ROOT"
elif [[ -n "$INSTANCE_DIR" && -f "$INSTANCE_DIR/.env" ]]; then
  :
elif [[ -f "$ROOT/.env" ]]; then
  cd "$ROOT"
  INSTANCE_DIR=""
else
  echo "[doctor] no .env found; pass --dir INSTANCE_DIR or run from an instance/package dir" >&2
  exit 1
fi

if [[ -n "${INSTANCE_DIR:-}" && -f "$INSTANCE_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$INSTANCE_DIR/.env"
  set +a
  ENV_FILE="$INSTANCE_DIR/.env"
  COMPOSE_FILE="${INSTANCE_DIR}/docker-compose.yml"
  PROJECT_NAME="${PROJECT_NAME:-${COMPOSE_PROJECT_NAME:-$(project_name_from_dir "$INSTANCE_DIR" 2>/dev/null || basename "$INSTANCE_DIR")}}"
else
  [[ -f .env ]] && set -a && source .env && set +a
  ENV_FILE=".env"
  COMPOSE_FILE="docker-compose.yml"
  PROJECT_NAME="${PROJECT_NAME:-${COMPOSE_PROJECT_NAME:-}}"
fi

WEB_PORT="${WEB_PORT:-23000}"
MASTER_KEY_FILE="${MASTER_KEY_FILE:-${INSTANCE_DIR:-.}/.secrets/vulnhunter-master.key}"
DATA_DIR="${DATA_DIR:-${INSTANCE_DIR:-/opt/vulnhunter/data}}"
SERVICE_UID="${SERVICE_UID:-1001}"
SERVICE_GID="${SERVICE_GID:-1001}"

compose() {
  local args=()
  if [[ -n "${PROJECT_NAME:-}" ]]; then args+=(-p "$PROJECT_NAME"); fi
  if [[ -f "${ENV_FILE:-}" ]]; then args+=(--env-file "$ENV_FILE"); fi
  if [[ -f "${COMPOSE_FILE:-}" ]]; then args+=(-f "$COMPOSE_FILE"); fi
  if docker compose version >/dev/null 2>&1; then
    docker compose "${args[@]}" "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose "${args[@]}" "$@"
  else
    echo "[doctor] Docker Compose is required: install Docker Compose v2 ('docker compose') or legacy docker-compose" >&2
    return 127
  fi
}

fail=0
check() { if "$@" >/dev/null 2>&1; then echo "[ok] $*"; else echo "[fail] $*"; fail=1; fi; }
check_shell() { local name="$1"; shift; if "$@" >/dev/null 2>&1; then echo "[ok] $name"; else echo "[fail] $name"; fail=1; fi; }
mount_source() { docker inspect "$1" --format "{{range .Mounts}}{{if eq .Destination \"$2\"}}{{.Source}}{{end}}{{end}}" 2>/dev/null || true; }
check_mount_source() { [[ "$(mount_source "$1" "$2")" == "$3" ]]; }
check_service_socket() {
  docker exec -i vulnhunter-service node <<'NODE'
const net = require('node:net');
const c = net.createConnection('/var/run/docker.sock');
c.setTimeout(3000);
c.on('connect', () => c.write('GET /_ping HTTP/1.0\r\n\r\n'));
c.on('data', (d) => process.exit(d.toString().includes('OK') ? 0 : 1));
c.on('timeout', () => process.exit(1));
c.on('error', () => process.exit(1));
NODE
}
check_db_initialized_readable() {
  docker run --rm --user 70:70 -v "$DATA_DIR/db:/var/lib/postgresql/data:ro" "${POSTGRES_IMAGE:-postgres:16-alpine}" sh -c 'test -r /var/lib/postgresql/data/PG_VERSION || exit 1; for f in $(find /var/lib/postgresql/data/base -type f | head -n 20); do test -r "$f" && exit 0; done; exit 1'
}


echo "== VulnHunter doctor =="
check docker info
check compose version

echo "-- containers --"
compose ps || fail=1

check_shell "master key file exists" test -f "$MASTER_KEY_FILE"
check_shell "master key readable by service uid" docker run --rm --user "${SERVICE_UID}:${SERVICE_GID}" -v "$MASTER_KEY_FILE:/run/secrets/vulnhunter-master.key:ro" "${SERVICE_IMAGE:-vulnhunter-service:latest}" node -e "require('node:fs').readFileSync('/run/secrets/vulnhunter-master.key','utf8')"
check_shell "data dir writable by service uid" docker run --rm --user "${SERVICE_UID}:${SERVICE_GID}" -v "$DATA_DIR:$DATA_DIR" "${SERVICE_IMAGE:-vulnhunter-service:latest}" node -e "require('node:fs').writeFileSync('${DATA_DIR}/.doctor-write-test','ok'); require('node:fs').unlinkSync('${DATA_DIR}/.doctor-write-test')"
check_shell "DATA_DIR/db writable by postgres uid" docker run --rm --user 70:70 -v "$DATA_DIR/db:/var/lib/postgresql/data" "${POSTGRES_IMAGE:-postgres:16-alpine}" sh -c 'touch /var/lib/postgresql/data/.doctor-write-test && rm /var/lib/postgresql/data/.doctor-write-test'
check_shell "DATA_DIR/minio writable" docker run --rm --entrypoint sh -v "$DATA_DIR/minio:/data" "${MINIO_IMAGE:-minio/minio:RELEASE.2025-09-07T16-13-09Z}" -c 'touch /data/.doctor-write-test && rm /data/.doctor-write-test'
identity_probe=".doctor-path-identity-$$"
printf 'ok' > "${DATA_DIR}/${identity_probe}"
check_shell "data dir path identity in service" docker exec vulnhunter-service test -f "${DATA_DIR}/${identity_probe}"
rm -f "${DATA_DIR}/${identity_probe}"
check_shell "web root" curl -fsS "http://127.0.0.1:${WEB_PORT}/"
check_shell "system status API" curl -fsS "http://127.0.0.1:${WEB_PORT}/api/system/status"
check_shell "service health" docker exec vulnhunter-service node -e "fetch('http://127.0.0.1:28080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
check_shell "service git available" docker exec vulnhunter-service git --version
check_shell "database health" sh -c "docker inspect --format='{{.State.Health.Status}}' vulnhunter-db | grep -qx healthy"
check_shell "minio health" sh -c "docker inspect --format='{{.State.Health.Status}}' vulnhunter-minio | grep -qx healthy"
check_shell "DATA_DIR/db initialized files readable by postgres uid" check_db_initialized_readable
check_shell "db mount source is DATA_DIR/db" check_mount_source vulnhunter-db /var/lib/postgresql/data "$DATA_DIR/db"
check_shell "minio mount source is DATA_DIR/minio" check_mount_source vulnhunter-minio /data "$DATA_DIR/minio"
check_shell "worker image present" docker image inspect "${WORKER_IMAGE:-vulnhunter-worker:latest}"
check_shell "eval worker image present" docker image inspect "${EVAL_WORKER_IMAGE:-vulnhunter-eval-worker:latest}"
check_shell "service docker socket access" check_service_socket

# Optional SandboxPlane reachability (WARN only — remote plane may be in maintenance)
if [[ -f "${ENV_FILE:-.env}" ]] && grep -qE '^SANDBOXPLANE_BASE_URL=.+' "${ENV_FILE:-.env}"; then
  plane_url="$(grep -E '^SANDBOXPLANE_BASE_URL=' "${ENV_FILE:-.env}" | tail -n1 | cut -d= -f2-)"
  if [[ -n "$plane_url" ]]; then
    livez="${plane_url%/}/livez"
    # rewrite internal hostname for host-side probe when possible
    livez_host="${livez//sandbox-plane/127.0.0.1}"
    if curl -fsS --max-time 3 "$livez_host" >/dev/null 2>&1 || curl -fsS --max-time 3 "$livez" >/dev/null 2>&1; then
      echo "[ok] sandbox-plane livez ($plane_url)"
    else
      echo "[warn] sandbox-plane not reachable at $plane_url (dynamic may fail)"
    fi
  fi
fi

echo "-- system status --"
curl -fsS "http://127.0.0.1:${WEB_PORT}/api/system/status" || true
echo ""

if [[ "$fail" == 0 ]]; then
  echo "doctor passed"
else
  echo "doctor failed" >&2
  exit 1
fi
