#!/bin/bash
set -e
# Scan mode: download code zip → unzip → run youngflow → sync outputs to MinIO

TASK_ID="${TASK_ID:?TASK_ID is required}"
MINIO_BUCKET="${MINIO_BUCKET:-vulnhunt}"

echo "[scan] Starting scan for task: $TASK_ID"

if [ -z "$RESUME" ] || [ "$RESUME" = "0" ]; then
  echo "[scan] Downloading code package from MinIO..."
  mc cp "minio/${MINIO_BUCKET}/code-packages/${TASK_ID}.zip" /tmp/code.zip
  mkdir -p /workspace/src
  unzip -q /tmp/code.zip -d /workspace/src
  rm /tmp/code.zip
  echo "[scan] Code package extracted"
else
  echo "[scan] Resuming from existing workspace"
fi

mkdir -p /workspace/out

echo "[scan] Running youngflow..."
youngflow /opt/vulnhunt/flows/vulnhunt \
  --work-dir /workspace/src \
  --output-dir /workspace/out \
  --emit-service-events \
  ${RESUME:+--resume}

EXIT=$?

echo "[scan] Syncing outputs to MinIO..."
mc cp --recursive /workspace/out/ "minio/${MINIO_BUCKET}/scan-outputs/${TASK_ID}/"

echo "[scan] Done (exit=$EXIT)"
exit $EXIT
