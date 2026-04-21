#!/bin/bash
set -e

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
