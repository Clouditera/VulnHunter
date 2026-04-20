#!/bin/bash
set -e

MODE="${MODE:-scan}"

# Configure MinIO client
mc alias set minio "${MINIO_ENDPOINT:-http://minio:9000}" \
   "${MINIO_ACCESS_KEY:-minioadmin}" "${MINIO_SECRET_KEY:-minioadmin}" 2>/dev/null || true

case "$MODE" in
  scan)
    exec /opt/vulnhunt/scan-mode.sh
    ;;
  chat)
    exec /opt/vulnhunt/chat-mode.sh
    ;;
  report)
    exec /opt/vulnhunt/report-mode.sh
    ;;
  *)
    echo "Unknown MODE: $MODE (expected scan|chat|report)" >&2
    exit 1
    ;;
esac
