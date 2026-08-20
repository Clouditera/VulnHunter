#!/usr/bin/env bash
# Unit tests for deploy/lib/common.sh docker/compose version preflight (HALL-8).
# docker / docker-compose are mocked via a temp PATH dir — no real daemon needed.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../lib/common.sh
source "$ROOT/lib/common.sh"

fail=0
MOCK_BIN="$(mktemp -d)"
BASE_BIN="$(mktemp -d)"
trap 'rm -rf "$MOCK_BIN" "$BASE_BIN"' EXIT
# Minimal clean PATH (host may ship a real docker/docker-compose that would
# leak into the mocks): only the coreutils the preflight actually calls.
for t in bash env sort head sed; do
  ln -s "$(command -v "$t")" "$BASE_BIN/$t"
done

# mock_docker <engine-version|FAIL> <compose-version|none>
# engine FAIL: `docker version`/`docker info` yield no server version.
# compose none: `docker compose version` exits 1 (plugin absent).
mock_docker() {
  local engine="$1" compose="$2"
  cat >"$MOCK_BIN/docker" <<EOF
#!/usr/bin/env bash
case "\$*" in
  "version --format {{.Server.Version}}")
    [[ "$engine" == FAIL ]] && exit 1
    echo "$engine" ;;
  info)
    [[ "$engine" == FAIL ]] && exit 1
    printf 'Server Version: %s\n' "$engine" ;;
  "compose version"|"compose version --short")
    [[ "$compose" == none ]] && exit 1
    [[ "\$*" == *--short* ]] && echo "$compose" || echo "Docker Compose version $compose" ;;
  *) exit 1 ;;
esac
EOF
  chmod +x "$MOCK_BIN/docker"
  rm -f "$MOCK_BIN/docker-compose"
}

assert_case() {
  local name="$1" want_rc="$2" want_msg="$3"
  local out rc
  out="$( (PATH="$MOCK_BIN:$BASE_BIN" check_docker_requirements) 2>&1 )" && rc=0 || rc=$?
  if [[ "$rc" == "$want_rc" ]] && { [[ -z "$want_msg" ]] || [[ "$out" == *"$want_msg"* ]]; }; then
    echo "[ok] $name"
  else
    echo "[fail] $name: rc=$rc (want $want_rc) out='$out'" >&2
    fail=1
  fi
}

echo "== docker requirements preflight =="

mock_docker 20.10.24 2.27.0
assert_case "docker 20.10 + compose v2 passes" 0 ""

mock_docker 24.0.7 v2.23.3
assert_case "docker 24 + compose v2 (v-prefix) passes" 0 ""

mock_docker 19.03.15 2.27.0
assert_case "docker < 20.10 rejected" 1 "Docker Engine >= 20.10 is required (detected: 19.03.15)"

mock_docker 24.0.7 none
printf '#!/usr/bin/env bash\necho "docker-compose version 1.29.2"\n' >"$MOCK_BIN/docker-compose"
chmod +x "$MOCK_BIN/docker-compose"
assert_case "legacy docker-compose v1 rejected" 1 "Detected legacy docker-compose v1"

mock_docker 24.0.7 none
assert_case "no compose at all rejected" 1 "not found"

mock_docker FAIL 2.27.0
assert_case "undetectable engine version rejected" 1 "cannot determine Docker Engine version"

exit "$fail"
