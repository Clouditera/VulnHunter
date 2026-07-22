#!/usr/bin/env bash
# Unit tests for deploy/lib/rename-migrate.sh pure helpers (no docker required).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/lib/rename-migrate.sh"

pass=0
fail=0
assert_eq() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    echo "  PASS  $name"
    pass=$((pass + 1))
  else
    echo "  FAIL  $name"
    echo "        expected: $expected"
    echo "        actual:   $actual"
    fail=$((fail + 1))
  fi
}
assert_rc() {
  local name="$1" expected_rc="$2"
  shift 2
  set +e
  "$@" >/dev/null 2>&1
  local rc=$?
  set -e
  if [[ "$rc" -eq "$expected_rc" ]]; then
    echo "  PASS  $name (rc=$rc)"
    pass=$((pass + 1))
  else
    echo "  FAIL  $name (expected rc=$expected_rc got $rc)"
    fail=$((fail + 1))
  fi
}

echo "== rename_data_dir_needs_move =="
assert_rc "default path needs move" 0 rename_data_dir_needs_move "/opt/vulnagent/data"
assert_rc "31.102 path needs move" 0 rename_data_dir_needs_move "/home/clouditera/vulnagent-data"
assert_rc "neutral custom path no move" 1 rename_data_dir_needs_move "/data/platform"
assert_rc "empty path no move" 1 rename_data_dir_needs_move ""

echo "== rename_map_data_dir_path =="
assert_eq "default" "/opt/vulnhunter/data" "$(rename_map_data_dir_path "/opt/vulnagent/data")"
assert_eq "31.102" "/home/clouditera/vulnhunter-data" "$(rename_map_data_dir_path "/home/clouditera/vulnagent-data")"
assert_eq "neutral unchanged" "/data/platform" "$(rename_map_data_dir_path "/data/platform")"

echo "== rename_rewrite_env_body =="
input=$(cat <<'EOF'
# comment stays
WEB_PORT=23000
DATA_DIR=/home/clouditera/vulnagent-data
SERVICE_IMAGE=vulnagent-service:2.3.0
WEB_IMAGE=vulnagent-web:2.3.0
WORKER_IMAGE=vulnagent-worker:2.3.0
EVAL_WORKER_IMAGE=vulnagent-eval-worker:2.3.0
MINIO_BUCKET=vulnagent
DOCKER_NETWORK=vulnagent-internal
VULNAGENT_MASTER_KEY_FILE=/home/clouditera/vulnagent-data/.secrets/vulnagent-master.key
MASTER_KEY_FILE=/home/clouditera/vulnagent-data/.secrets/vulnagent-master.key
DATABASE_URL=postgresql://vulnagent:secret@db:5432/vulnagent
DB_PASSWORD=secret-with-vulnagent-substring
MINIO_ACCESS_KEY=minioadmin
EOF
)
out="$(printf '%s\n' "$input" | rename_rewrite_env_body)"

assert_eq "comment preserved" "# comment stays" "$(printf '%s\n' "$out" | sed -n '1p')"
assert_eq "DATA_DIR rewritten" "/home/clouditera/vulnhunter-data" "$(printf '%s\n' "$out" | sed -n 's/^DATA_DIR=//p')"
assert_eq "SERVICE_IMAGE rewritten" "vulnhunter-service:2.3.0" "$(printf '%s\n' "$out" | sed -n 's/^SERVICE_IMAGE=//p')"
assert_eq "MINIO_BUCKET → artifact-store" "artifact-store" "$(printf '%s\n' "$out" | sed -n 's/^MINIO_BUCKET=//p')"
assert_eq "DOCKER_NETWORK rewritten" "vulnhunter-internal" "$(printf '%s\n' "$out" | sed -n 's/^DOCKER_NETWORK=//p')"
assert_eq "VULNAGENT_ key renamed" "/home/clouditera/vulnhunter-data/.secrets/vulnhunter-master.key" \
  "$(printf '%s\n' "$out" | sed -n 's/^VULNHUNTER_MASTER_KEY_FILE=//p')"
assert_eq "no leftover VULNAGENT_ keys" "" "$(printf '%s\n' "$out" | grep -E '^VULNAGENT_' || true)"
assert_eq "DATABASE_URL role+db" "postgresql://vulnhunter:secret@db:5432/vulnhunter" \
  "$(printf '%s\n' "$out" | sed -n 's/^DATABASE_URL=//p')"
assert_eq "password with substring NOT rewritten" "secret-with-vulnagent-substring" \
  "$(printf '%s\n' "$out" | sed -n 's/^DB_PASSWORD=//p')"
assert_eq "MASTER_KEY_FILE path+name" "/home/clouditera/vulnhunter-data/.secrets/vulnhunter-master.key" \
  "$(printf '%s\n' "$out" | sed -n 's/^MASTER_KEY_FILE=//p')"

echo "== rename_minio_plan (idempotent branches) =="
minio_fx="$(mktemp -d)"
# layout: old bucket with 2 files; no new bucket → full_copy
mkdir -p "$minio_fx/oldb" "$minio_fx/oldm"
printf a > "$minio_fx/oldb/f1"; printf b > "$minio_fx/oldb/f2"
printf m > "$minio_fx/oldm/meta"
assert_eq "full_copy when new missing" "full_copy" \
  "$(rename_minio_plan "$minio_fx/oldb" "$minio_fx/newb" "$minio_fx/oldm" "$minio_fx/newm")"
# content present + matching counts, metadata missing → meta_only (31.102 half-migrate)
mkdir -p "$minio_fx/newb"
cp -a "$minio_fx/oldb/." "$minio_fx/newb/"
# simulate root-owned meta dir unreadable for write by using a present old meta + absent new meta
assert_eq "meta_only when content ok meta missing" "meta_only" \
  "$(rename_minio_plan "$minio_fx/oldb" "$minio_fx/newb" "$minio_fx/oldm" "$minio_fx/newm")"
# content + metadata both present → skip
mkdir -p "$minio_fx/newm"
assert_eq "skip when content+meta ok" "skip" \
  "$(rename_minio_plan "$minio_fx/oldb" "$minio_fx/newb" "$minio_fx/oldm" "$minio_fx/newm")"
# count mismatch with new present → still skip (post-rename growth is normal;
# never delete/re-copy the live new bucket)
printf c > "$minio_fx/newb/extra"
assert_eq "skip when new present even if counts differ" "skip" \
  "$(rename_minio_plan "$minio_fx/oldb" "$minio_fx/newb" "$minio_fx/oldm" "$minio_fx/newm")"
# neither side → create_empty
rm -rf "$minio_fx"
minio_fx="$(mktemp -d)"
assert_eq "create_empty when neither side" "create_empty" \
  "$(rename_minio_plan "$minio_fx/oldb" "$minio_fx/newb" "$minio_fx/oldm" "$minio_fx/newm")"
rm -rf "$minio_fx"

echo "== package detection (fixture) =="
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
pushd "$tmpdir" >/dev/null
assert_rc "no compose → not new product" 1 rename_package_targets_new_product
printf 'container_name: vulnhunter-service\n' > docker-compose.yml
assert_rc "compose has vulnhunter-service → new product" 0 rename_package_targets_new_product
rm docker-compose.yml
printf '{"product":"vulnhunter"}\n' > VERSION.json
assert_rc "VERSION product vulnhunter → new product" 0 rename_package_targets_new_product
popd >/dev/null

echo
echo "== rename_install_has_old_naming (second-upgrade no-op) =="
fx="$(mktemp -d)"
pushd "$fx" >/dev/null
# Already-renamed .env: new images, artifact-store, no VULNAGENT_ keys
cat > .env <<'E'
WEB_PORT=23000
DATA_DIR=/home/clouditera/vulnhunter-data
SERVICE_IMAGE=vulnhunter-service:2.3.0
WEB_IMAGE=vulnhunter-web:2.3.0
WORKER_IMAGE=vulnhunter-worker:2.3.0
MINIO_BUCKET=artifact-store
DOCKER_NETWORK=vulnhunter-internal
MASTER_KEY_FILE=/home/clouditera/vulnhunter-data/.secrets/vulnhunter-master.key
E
# Leftover old network / old manifest must NOT trip detection
touch .vulnagent-install.json
# Simulate docker network list by not calling real docker for network —
# rename_install_has_old_naming no longer checks network/manifest.
assert_rc "renamed .env → not old naming" 1 rename_install_has_old_naming

# Old .env keys still present → old naming
cat > .env <<'E'
SERVICE_IMAGE=vulnagent-service:2.2.0
MINIO_BUCKET=vulnagent
E
assert_rc "old image+bucket in .env → old naming" 0 rename_install_has_old_naming

# Package targets new + install already new → migration not needed
printf 'container_name: vulnhunter-service\n' > docker-compose.yml
cat > .env <<'E'
SERVICE_IMAGE=vulnhunter-service:2.3.0
MINIO_BUCKET=artifact-store
E
assert_rc "second upgrade migration_needed=false" 1 rename_migration_needed

# Package new + install old → migration needed
cat > .env <<'E'
SERVICE_IMAGE=vulnagent-service:2.2.0
MINIO_BUCKET=vulnagent
VULNAGENT_MASTER_KEY_FILE=/x
E
assert_rc "first upgrade migration_needed=true" 0 rename_migration_needed
popd >/dev/null
rm -rf "$fx"

echo "Results: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
