FROM node:20-slim AS base
WORKDIR /opt/vulnhunt

# System dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
      git unzip zip curl ca-certificates jq \
    && rm -rf /var/lib/apt/lists/*

# pi CLI (youngflow spawns it for each stage)
RUN npm install -g @mariozechner/pi-coding-agent \
    && pi install npm:pi-mcp-adapter

# youngflow — copy built dist + deps from submodule
COPY submodules/youngflow/package.json /opt/youngflow/package.json
COPY submodules/youngflow/dist /opt/youngflow/dist
COPY submodules/youngflow/bin /opt/youngflow/bin
COPY submodules/youngflow/node_modules /opt/youngflow/node_modules
RUN chmod +x /opt/youngflow/bin/youngflow.js \
    && ln -s /opt/youngflow/bin/youngflow.js /usr/local/bin/youngflow

# vulnhunt flow assets (separate from youngflow submodule)
COPY flows/vulnhunt /opt/vulnhunt/flows/vulnhunt

# Worker bridge (for chat/report modes)
COPY packages/worker-bridge/dist/bundle.js /opt/bridge/bundle.js
COPY packages/worker-bridge/package.json /opt/bridge/package.json
RUN cd /opt/bridge && npm install --omit=dev --ignore-scripts 2>/dev/null || true

# Worker scripts
COPY worker-assets/entrypoint.sh /opt/entrypoint.sh
COPY worker-assets/scan-mode.sh /opt/scan-mode.sh
COPY worker-assets/chat-mode.sh /opt/chat-mode.sh
RUN chmod +x /opt/entrypoint.sh /opt/scan-mode.sh /opt/chat-mode.sh

WORKDIR /workspace
ENTRYPOINT ["/opt/entrypoint.sh"]
