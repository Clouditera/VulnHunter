#!/bin/sh
set -eu
umask 077
export PATH=/usr/local/bin:/usr/bin:/bin

: "${PREPARE_SOURCE_ROOT:?}"
: "${PREPARE_OUTPUT_DIR:?}"
: "${PREPARE_DYNAMIC_ENABLED:?}"
case "$PREPARE_DYNAMIC_ENABLED" in true|false) ;; *) echo "[prepare] invalid dynamic flag" >&2; exit 3;; esac

[ -d "$PREPARE_SOURCE_ROOT" ] && [ ! -L "$PREPARE_SOURCE_ROOT" ] || exit 3
if [ -L "$PREPARE_OUTPUT_DIR" ]; then exit 3; fi
if [ -e "$PREPARE_OUTPUT_DIR" ]; then
  [ -d "$PREPARE_OUTPUT_DIR" ] || exit 3
  [ -z "$(find "$PREPARE_OUTPUT_DIR" -mindepth 1 -maxdepth 1 -print -quit)" ] || exit 3
fi

# mktemp uses O_EXCL semantics: it cannot collide with or modify an existing source entry.
probe=""
if probe="$(mktemp "$PREPARE_SOURCE_ROOT/.prepare-readonly-probe.XXXXXX" 2>/dev/null)"; then
  rm -f -- "$probe"
  echo "[prepare] source mount is writable" >&2
  exit 3
fi

child=""
runtime=""
output_created=0
cleanup() {
  rc=$?
  trap - EXIT INT TERM HUP
  [ -z "$runtime" ] || rm -rf -- "$runtime"
  if [ "$rc" -ne 0 ] && [ -d "$PREPARE_OUTPUT_DIR" ] && [ ! -L "$PREPARE_OUTPUT_DIR" ]; then
    find "$PREPARE_OUTPUT_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + 2>/dev/null || true
    [ "$output_created" -eq 0 ] || rmdir "$PREPARE_OUTPUT_DIR" 2>/dev/null || true
  fi
  exit "$rc"
}
terminate() {
  if [ -n "$child" ]; then
    kill -TERM "$child" 2>/dev/null || true
    wait "$child" 2>/dev/null || true
    child=""
  fi
  exit 143
}
trap cleanup EXIT
trap terminate INT TERM HUP

runtime_root=${PREPARE_RUNTIME_ROOT:-/tmp}
[ -d "$runtime_root" ] && [ ! -L "$runtime_root" ] || exit 3
runtime=$(mktemp -d "$runtime_root/prepare-runtime.XXXXXX")
chmod 700 "$runtime"
if [ ! -e "$PREPARE_OUTPUT_DIR" ]; then mkdir "$PREPARE_OUTPUT_DIR"; output_created=1; fi
chmod 700 "$PREPARE_OUTPUT_DIR"
result_path="$PREPARE_OUTPUT_DIR/prepare-result.json"

youngflow /opt/vulnagent/flows/prepare/flow.prepare.yaml \
  --work-dir "$PREPARE_SOURCE_ROOT" --output-dir "$runtime" \
  --dynamic-enabled "$PREPARE_DYNAMIC_ENABLED" --result-path "$result_path" &
child=$!
wait "$child"
child=""

if [ -n "${PREPARE_SANDBOX_TYPES_FILE:-}" ]; then
  /opt/prepare-result-postflight.py "$PREPARE_OUTPUT_DIR" "$PREPARE_DYNAMIC_ENABLED" "$PREPARE_SANDBOX_TYPES_FILE"
else
  /opt/prepare-result-postflight.py "$PREPARE_OUTPUT_DIR" "$PREPARE_DYNAMIC_ENABLED"
fi
# Ownership handoff: this worker runs as root with umask 077, so the output
# dir (0700) and prepare-result.json (0600) are root-owned — but the service
# reads the result as uid 1001 and cannot even traverse the dir (P0 caught by
# the first real-model E2E, 2026-07-18). Hand ownership to the service uid
# AFTER postflight has validated the 0600/regular/nlink1 contract; modes stay
# exactly 0700/0600. chown failure is a loud nonzero exit via set -eu.
owner_uid="${PREPARE_OUTPUT_OWNER_UID:-1001}"
chown "$owner_uid:$owner_uid" "$PREPARE_OUTPUT_DIR" "$result_path"
rm -rf -- "$runtime"
runtime=""
