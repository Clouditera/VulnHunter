#!/bin/bash
set -euo pipefail

: "${TASK_ID:?TASK_ID is required}"
: "${POC_RUN_ID:?POC_RUN_ID is required}"
: "${FINDING_KEY:?FINDING_KEY is required}"
: "${TARGET_URL:?TARGET_URL is required}"

SCRIPT="/workspace/poc.sh"
LOG="/workspace/run.log"
EVENTS="/workspace/events/poc-run-${FINDING_KEY}.service.jsonl"

echo "[poc-run] Re-executing POC: finding=$FINDING_KEY target=$TARGET_URL" >&2

mkdir -p /workspace/events
chmod +x "$SCRIPT" 2>/dev/null || true

# Use run_poc.py for consistent event streaming
python3 /opt/vulnhunt/flows/vulnhunt-poc/skills/poc-executor/run_poc.py \
  --bug-id "${FINDING_KEY}" \
  --script "$SCRIPT" \
  --target-url "${TARGET_URL}" \
  --log "$LOG" \
  --events "$EVENTS" \
  --timeout "${POC_TIMEOUT:-300}"
