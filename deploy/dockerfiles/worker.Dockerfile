FROM node:20-slim AS base
WORKDIR /opt/vulnagent

# System dependencies (python3 + pyyaml needed by feature-aggregator, project-profiler)
RUN apt-get update && apt-get install -y --no-install-recommends \
      git unzip zip curl ca-certificates jq \
      python3 python3-yaml \
    && rm -rf /var/lib/apt/lists/*

# pi CLI (youngflow spawns it for each stage)
RUN npm install -g @mariozechner/pi-coding-agent \
    && pi install npm:pi-mcp-adapter

# youngflow — self-contained release binary (v0.3.8)
COPY submodules/youngflow/release/youngflow-linux-x64 /usr/local/bin/youngflow
RUN chmod +x /usr/local/bin/youngflow \
    && youngflow --version

# vulnforge scan flow assets (separate from youngflow submodule)
COPY flows/vulnforge /opt/vulnagent/flows/vulnforge
RUN cd /opt/vulnagent/flows/vulnforge/extensions/output-contract \
    && npm install --omit=dev --no-audit --no-fund \
    && npm install --omit=dev --no-audit --no-fund @earendil-works/pi-coding-agent
RUN cd /opt/vulnagent/flows/vulnforge/extensions/code-reading-coverage \
    && npm init -y >/dev/null \
    && npm install --omit=dev --no-audit --no-fund @mariozechner/pi-coding-agent @mariozechner/pi-ai
COPY flows/vulnagent-report /opt/vulnagent/flows/vulnagent-report

# Worker bridge (for chat/report modes)
COPY packages/worker-bridge/dist/bundle.js /opt/bridge/bundle.js
COPY packages/worker-bridge/package.json /opt/bridge/package.json
RUN cd /opt/bridge && npm install --omit=dev --ignore-scripts 2>/dev/null || true

# Worker scripts
COPY worker-assets/entrypoint.sh /opt/entrypoint.sh
COPY worker-assets/scan-mode.sh /opt/scan-mode.sh
COPY worker-assets/chat-mode.sh /opt/chat-mode.sh
COPY worker-assets/report-mode.sh /opt/report-mode.sh
RUN chmod +x /opt/entrypoint.sh /opt/scan-mode.sh /opt/chat-mode.sh /opt/report-mode.sh

WORKDIR /workspace
ENTRYPOINT ["/opt/entrypoint.sh"]
