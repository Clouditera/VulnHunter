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
  prepare)
    exec /opt/prepare-mode.sh
    ;;
  eval)
    exec /opt/eval-mode.sh
    ;;
  poc-run)
    exec /opt/poc-run-mode.sh
    ;;
  *)
    echo "Unknown MODE: $MODE (expected scan|chat|report|prepare|eval|poc-run)" >&2
    exit 1
    ;;
esac
