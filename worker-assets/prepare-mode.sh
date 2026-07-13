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
else
  mkdir "$PREPARE_OUTPUT_DIR"
fi
chmod 700 "$PREPARE_OUTPUT_DIR"

probe="$PREPARE_SOURCE_ROOT/.prepare-readonly-probe-$$"
if (: > "$probe") 2>/dev/null; then
  rm -f "$probe"
  echo "[prepare] source mount is writable" >&2
  exit 3
fi

child=""
cleanup() {
  rc=$?
  trap - EXIT INT TERM HUP
  if [ "$rc" -ne 0 ]; then
    find "$PREPARE_OUTPUT_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + 2>/dev/null || true
  fi
  exit "$rc"
}
terminate() {
  [ -z "$child" ] || { kill -TERM "$child" 2>/dev/null || true; wait "$child" 2>/dev/null || true; child=""; }
  exit 143
}
trap cleanup EXIT
trap terminate INT TERM HUP

set -- youngflow /opt/vulnagent/flows/prepare/flow.prepare.yaml \
  --work-dir "$PREPARE_SOURCE_ROOT" --output-dir "$PREPARE_OUTPUT_DIR" \
  --dynamic-enabled "$PREPARE_DYNAMIC_ENABLED"
"$@" &
child=$!
wait "$child"
child=""

if [ -n "${PREPARE_SANDBOX_TYPES_FILE:-}" ]; then
  /opt/prepare-result-postflight.py "$PREPARE_OUTPUT_DIR" "$PREPARE_DYNAMIC_ENABLED" "$PREPARE_SANDBOX_TYPES_FILE"
else
  /opt/prepare-result-postflight.py "$PREPARE_OUTPUT_DIR" "$PREPARE_DYNAMIC_ENABLED"
fi
