#!/bin/bash
set -e

# De-identified workers (non-root) get HOME injected by the service; make
# sure it exists (volume-mount workspaces can't be pre-created host-side).
export HOME="${HOME:-/workspace/.home}"
mkdir -p "$HOME" 2>/dev/null || true

# Numeric service UIDs need a passwd entry even when absent from the image.
# Source before every mode so SSH/git and agent subprocesses inherit the lookup.
source /opt/worker-identity.sh

MODE="${MODE:-scan}"

case "$MODE" in
  scan)
    exec /opt/scan-mode.sh
    ;;
  chat)
    exec /opt/chat-mode.sh
    ;;
  report)
    exec /opt/report-mode.sh
    ;;
  *)
    echo "Unknown MODE: $MODE (expected scan|chat|report)" >&2
    exit 1
    ;;
esac
