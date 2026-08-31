#!/usr/bin/env bash
# task-d159f518: edition-suffixed image tags. Shell-level pins:
#  1. three editions -> three distinct tags (no shared-daemon clobber)
#  2. release_patch_env_example stamps suffixed keys + edition
#  3. old instance (unsuffixed 2.3.12-era .env) is force-switched to the
#     package's suffixed keys by the upgrade image-key sync loop
set -u
fail=0
assert_eq() { [[ "$2" == "$3" ]] && echo "ok: $1" || { echo "FAIL: $1 — got '$2' want '$3'"; fail=1; }; }
assert_ne() { [[ "$2" != "$3" ]] && echo "ok: $1" || { echo "FAIL: $1 — '$2' == '$3'"; fail=1; }; }
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "== 1. three editions, distinct tags =="
VERSION=2.3.13
tags=()
for e in community enterprise saas; do
  IMAGE_TAG="$VERSION-$e"; tags+=("vulnhunter-service:$IMAGE_TAG")
done
assert_ne "community != enterprise" "${tags[0]}" "${tags[1]}"
assert_ne "enterprise != saas" "${tags[1]}" "${tags[2]}"
assert_ne "community != saas" "${tags[0]}" "${tags[2]}"
assert_eq "suffix shape" "${tags[1]}" "vulnhunter-service:2.3.13-enterprise"

echo "== 2. release_patch_env_example stamps suffixed keys =="
cat > "$tmp/env.example" << 'ENVEOF'
SERVICE_IMAGE=vulnhunter-service:latest
WEB_IMAGE=vulnhunter-web:latest
WORKER_IMAGE=vulnhunter-worker:latest
ENVEOF
IMAGE_TAG="2.3.13-saas"
for kv in SERVICE_IMAGE:vulnhunter-service WEB_IMAGE:vulnhunter-web WORKER_IMAGE:vulnhunter-worker; do
  key="${kv%%:*}"; repo="${kv##*:}"
  sed -i "s|^${key}=.*|${key}=${repo}:$IMAGE_TAG|" "$tmp/env.example"
done
printf 'EDITION=saas\n' >> "$tmp/env.example"
assert_eq "service key" "$(sed -n 's/^SERVICE_IMAGE=//p' "$tmp/env.example")" "vulnhunter-service:2.3.13-saas"
assert_eq "web key" "$(sed -n 's/^WEB_IMAGE=//p' "$tmp/env.example")" "vulnhunter-web:2.3.13-saas"
assert_eq "worker key" "$(sed -n 's/^WORKER_IMAGE=//p' "$tmp/env.example")" "vulnhunter-worker:2.3.13-saas"

echo "== 3. old instance force-switched to suffixed package keys =="
cat > "$tmp/pkg.env.example" << 'ENVEOF'
SERVICE_IMAGE=vulnhunter-service:2.3.13-enterprise
WEB_IMAGE=vulnhunter-web:2.3.13-enterprise
WORKER_IMAGE=vulnhunter-worker:2.3.13-enterprise
EDITION=enterprise
ENVEOF
cat > "$tmp/inst.env" << 'ENVEOF'
SERVICE_IMAGE=vulnhunter-service:2.3.12
WEB_IMAGE=vulnhunter-web:2.3.12
WORKER_IMAGE=vulnhunter-worker:2.3.12
EDITION=enterprise
WEB_PORT=23000
ENVEOF
real_env="$tmp/inst.env"
for key in SERVICE_IMAGE WEB_IMAGE WORKER_IMAGE; do
  value="$(grep -E "^${key}=" "$tmp/pkg.env.example" | tail -n 1 | cut -d= -f2-)"
  [[ -n "$value" ]] || continue
  if grep -qE "^${key}=" "$real_env"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$real_env"
  else
    printf '%s=%s\n' "${key}=${value}" >> "$real_env"
  fi
done
assert_eq "old service key switched" "$(sed -n 's/^SERVICE_IMAGE=//p' "$real_env")" "vulnhunter-service:2.3.13-enterprise"
assert_eq "old worker key switched" "$(sed -n 's/^WORKER_IMAGE=//p' "$real_env")" "vulnhunter-worker:2.3.13-enterprise"
assert_eq "user value untouched" "$(sed -n 's/^WEB_PORT=//p' "$real_env")" "23000"

if [[ "$fail" == "0" ]]; then echo "ALL PASSED"; else echo "FAILURES"; exit 1; fi
