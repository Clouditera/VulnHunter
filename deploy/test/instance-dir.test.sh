#!/usr/bin/env bash
# Unit tests for deploy/lib/instance-dir.sh (batch 1 helpers)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../lib/instance-dir.sh
source "$ROOT/lib/instance-dir.sh"

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
assert_file() {
  local name="$1" path="$2"
  if [[ -f "$path" ]]; then
    echo "[ok] $name"
  else
    echo "[fail] $name: missing $path" >&2
    fail=1
  fi
}

echo "== instance-dir helpers =="

assert_eq "project_name data" "$(project_name_from_dir /opt/vulnhunter/data)" "vulnhunter-data"
assert_eq "project_name custom" "$(project_name_from_dir /srv/vh-prod)" "vulnhunter-vh-prod"
assert_eq "project_name strips junk" "$(project_name_from_dir '/tmp/Foo Bar!!')" "vulnhunter-foo-bar"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

write_version_file "$tmp/inst" "2.3.2" "abc1234" "2026-07-31T00:00:00.000Z"
assert_file "version file" "$tmp/inst/.version"
assert_eq "version field" "$(instance_version_field "$tmp/inst" version)" "2.3.2"
assert_eq "gitCommit field" "$(instance_version_field "$tmp/inst" gitCommit)" "abc1234"
if instance_is_present "$tmp/inst"; then echo "[ok] instance_is_present"; else echo "[fail] instance_is_present"; fail=1; fi
if instance_is_present "$tmp/empty"; then echo "[fail] empty should not be present"; fail=1; else echo "[ok] empty not present"; fi

# seed sandbox
mkdir -p "$tmp/pkg/sandbox"
echo 'services: {}' >"$tmp/pkg/sandbox/docker-compose.yml"
echo 'cfg: 1' >"$tmp/pkg/sandbox/config.yaml"
echo 'profiles: []' >"$tmp/pkg/sandbox/profiles.yaml"
printf '#!/bin/sh\necho ok\n' >"$tmp/pkg/sandbox/install.sh"
chmod +x "$tmp/pkg/sandbox/install.sh"
seed_instance_sandbox "$tmp/pkg" "$tmp/inst"
assert_file "seeded compose" "$tmp/inst/sandbox/docker-compose.yml"
assert_file "seeded config" "$tmp/inst/sandbox/config.yaml"
assert_file "seeded profiles" "$tmp/inst/sandbox/profiles.yaml"
assert_file "seeded install.sh" "$tmp/inst/sandbox/install.sh"
[[ -d "$tmp/inst/sandbox/secrets" ]] && echo "[ok] secrets dir" || { echo "[fail] secrets dir"; fail=1; }

# install.sh syntax
if bash -n "$ROOT/install.sh"; then echo "[ok] install.sh bash -n"; else echo "[fail] install.sh bash -n"; fail=1; fi
if bash -n "$ROOT/doctor.sh"; then echo "[ok] doctor.sh bash -n"; else echo "[fail] doctor.sh bash -n"; fail=1; fi
if bash -n "$ROOT/sandbox/install.sh"; then echo "[ok] sandbox/install.sh bash -n"; else echo "[fail] sandbox/install.sh bash -n"; fail=1; fi

# install --help
if "$ROOT/install.sh" --help | grep -q 'INSTANCE_DIR'; then
  echo "[ok] install --help"
else
  echo "[fail] install --help"; fail=1
fi

# Dry refuse: existing .version
mkdir -p "$tmp/existing"
write_version_file "$tmp/existing" "2.3.1" "old"
if INSTANCE_DIR="$tmp/existing" "$ROOT/install.sh" 2>"$tmp/err"; then
  echo "[fail] should refuse existing .version"; fail=1
else
  if grep -q 'existing instance' "$tmp/err"; then
    echo "[ok] refuses existing instance"
  else
    echo "[fail] refuse message missing: $(cat "$tmp/err")"; fail=1
  fi
fi

if [[ "$fail" -ne 0 ]]; then
  echo "FAILED" >&2
  exit 1
fi
echo "ALL PASSED"
