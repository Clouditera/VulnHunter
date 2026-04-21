#!/bin/bash
set -e

TASK_ID="${TASK_ID:?TASK_ID is required}"

echo "[scan] Starting scan for task: $TASK_ID" >&2

# Code already extracted to /workspace/src/ by service (bind mount)
# No mc download needed (Phase 4 bind mount architecture)

mkdir -p /workspace/out/.youngflow/logs

echo "[scan] Running youngflow..." >&2
youngflow /opt/vulnhunt/flows/vulnhunt \
  --work-dir /workspace/src \
  --output-dir /workspace/out \
  --json-log \
  ${RESUME:+--resume} \
  2>/workspace/out/.youngflow/logs/service-events.jsonl

EXIT=$?

# Product sync handled by service-side syncOutputsToMinio (Phase 4 architecture)
# No mc cp needed

echo "[scan] Done (exit=$EXIT)" >&2
exit $EXIT
