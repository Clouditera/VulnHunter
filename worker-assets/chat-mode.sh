#!/bin/bash
set -e

echo "[chat] Starting chat worker bridge..." >&2

# Bridge runs as a Node.js process, manages pi rpc lifecycle
exec node /opt/bridge/bundle.js
