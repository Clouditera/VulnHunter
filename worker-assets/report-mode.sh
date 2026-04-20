#!/bin/bash
set -e
# Report mode: same as chat mode but role=report

REPORT_ID="${REPORT_ID:?REPORT_ID is required}"
TASK_ID="${TASK_ID:?TASK_ID is required}"
MINIO_BUCKET="${MINIO_BUCKET:-vulnhunt}"

echo "[report] Starting report worker: task=$TASK_ID report=$REPORT_ID"

mkdir -p /workspace/reports

# Generate MCP config for pi
mkdir -p /root/.pi/agent
cat > /root/.pi/agent/mcp.json << EOF
{
  "mcpServers": {
    "platform": {
      "url": "${SERVICE_URL:-http://vulnhunt-service:8080}/mcp",
      "headers": {
        "Authorization": "Bearer ${CHAT_WORKER_TOKEN}"
      }
    }
  }
}
EOF

echo "[report] Starting bridge (report mode)..."
exec node /opt/bridge/bundle.js
