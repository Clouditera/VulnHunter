FROM node:20-slim AS base
WORKDIR /opt/vulnhunt

# System dependencies — includes Docker CLI for auto-deploy mode
RUN apt-get update && apt-get install -y --no-install-recommends \
      git unzip zip curl ca-certificates jq python3 \
    && rm -rf /var/lib/apt/lists/*

# Docker CLI (for auto-deploy mode — docker compose up in eval container)
RUN curl -fsSL https://download.docker.com/linux/static/stable/x86_64/docker-27.5.1.tgz \
    | tar xz --strip-components=1 -C /usr/local/bin docker/docker \
    && curl -fsSL "https://github.com/docker/compose/releases/download/v2.32.4/docker-compose-linux-x86_64" \
       -o /usr/local/bin/docker-compose \
    && chmod +x /usr/local/bin/docker-compose \
    && mkdir -p /usr/local/lib/docker/cli-plugins \
    && ln -s /usr/local/bin/docker-compose /usr/local/lib/docker/cli-plugins/docker-compose

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

# DeVeye CLI — prebuilt binary for browser automation in POC flows
COPY submodules/DevEye/packages/cli/binaries/index-linux /usr/local/bin/deveye
RUN chmod +x /usr/local/bin/deveye

# POC flow assets
COPY flows/vulnhunt-poc /opt/vulnhunt/flows/vulnhunt-poc

# Worker bridge (for chat fallback — not primary for eval)
COPY packages/worker-bridge/dist/bundle.js /opt/bridge/bundle.js
COPY packages/worker-bridge/package.json /opt/bridge/package.json
RUN cd /opt/bridge && npm install --omit=dev --ignore-scripts 2>/dev/null || true

# Worker scripts
COPY worker-assets/entrypoint.sh /opt/entrypoint.sh
COPY worker-assets/eval-mode.sh /opt/eval-mode.sh
COPY worker-assets/poc-run-mode.sh /opt/poc-run-mode.sh
RUN chmod +x /opt/entrypoint.sh /opt/eval-mode.sh /opt/poc-run-mode.sh

WORKDIR /workspace
ENTRYPOINT ["/opt/entrypoint.sh"]
