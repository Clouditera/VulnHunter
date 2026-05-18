#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
[[ -f .env ]] && set -a && source .env && set +a
WEB_PORT="${WEB_PORT:-23000}"
MASTER_KEY_FILE="${MASTER_KEY_FILE:-./.secrets/vulnhunt-master.key}"
DATA_DIR="${DATA_DIR:-/opt/vulnhunt/data}"

echo "== VulnHunt doctor =="
fail=0
check() { if eval "$2" >/dev/null 2>&1; then echo "[ok] $1"; else echo "[fail] $1"; fail=1; fi; }

check "docker daemon" "docker info"
check "docker compose" "docker compose version"

echo "-- containers --"
docker compose ps || fail=1

check "master key file exists" "test -f '$MASTER_KEY_FILE'"
check "data dir writable by service uid" "docker run --rm --user 1001:1001 -v '$DATA_DIR:/data/vulnhunt' ${SERVICE_IMAGE:-vulnhunt-service:latest} node -e \"require('node:fs').writeFileSync('/data/vulnhunt/.doctor-write-test','ok'); require('node:fs').unlinkSync('/data/vulnhunt/.doctor-write-test')\""
check "web root" "curl -fsS http://127.0.0.1:${WEB_PORT}/"
check "system status API" "curl -fsS http://127.0.0.1:${WEB_PORT}/api/system/status"
check "service health" "docker exec vulnhunt-service node -e \"fetch('http://127.0.0.1:28080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""
check "database health" "docker inspect --format='{{.State.Health.Status}}' vulnhunt-db | grep -qx healthy"
check "minio health" "docker inspect --format='{{.State.Health.Status}}' vulnhunt-minio | grep -qx healthy"
check "worker image present" "docker image inspect ${WORKER_IMAGE:-vulnhunt-worker:latest}"
check "eval worker image present" "docker image inspect ${EVAL_WORKER_IMAGE:-vulnhunt-eval-worker:latest}"
check "service docker socket access" "docker exec vulnhunt-service node -e \"const net=require('node:net'); const c=net.createConnection('/var/run/docker.sock'); c.setTimeout(3000); c.on('connect',()=>{c.write('GET /_ping HTTP/1.0\\r\\n\\r\\n')}); c.on('data',(d)=>{process.exit(d.toString().includes('OK')?0:1)}); c.on('timeout',()=>process.exit(1)); c.on('error',()=>process.exit(1));\""

echo "-- system status --"
curl -fsS "http://127.0.0.1:${WEB_PORT}/api/system/status" || true
echo ""

if [[ "$fail" == 0 ]]; then
  echo "doctor passed"
else
  echo "doctor failed" >&2
  exit 1
fi
