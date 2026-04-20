#!/bin/bash
set -e
# Chat mode: restore session → start bridge (pi rpc inside)

SESSION_ID="${SESSION_ID:?SESSION_ID is required}"
MINIO_BUCKET="${MINIO_BUCKET:-vulnhunt}"

echo "[chat] Starting chat worker for session: $SESSION_ID"

mkdir -p /session

# Restore session file from MinIO if it exists
mc cp "minio/${MINIO_BUCKET}/chat-sessions/${SESSION_ID}/session.jsonl" /session/session.jsonl 2>/dev/null || true

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

echo "[chat] Starting bridge..."
exec node /opt/bridge/bundle.js
