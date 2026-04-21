FROM node:20-slim AS base
WORKDIR /opt/vulnhunt

# System dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
      git unzip zip curl ca-certificates jq \
    && rm -rf /var/lib/apt/lists/*

# pi CLI (youngflow spawns it for each stage)
RUN npm install -g @anthropic-ai/claude-code

# youngflow — copy built dist + deps from submodule
COPY submodules/youngflow/package.json /opt/youngflow/package.json
COPY submodules/youngflow/dist /opt/youngflow/dist
COPY submodules/youngflow/bin /opt/youngflow/bin
COPY submodules/youngflow/node_modules /opt/youngflow/node_modules
RUN chmod +x /opt/youngflow/bin/youngflow.js \
    && ln -s /opt/youngflow/bin/youngflow.js /usr/local/bin/youngflow

# vulnhunt flow assets (separate from youngflow submodule)
COPY flows/vulnhunt /opt/vulnhunt/flows/vulnhunt

# Worker scripts
COPY worker-assets/entrypoint.sh /opt/entrypoint.sh
COPY worker-assets/scan-mode.sh /opt/scan-mode.sh
RUN chmod +x /opt/entrypoint.sh /opt/scan-mode.sh

WORKDIR /workspace
ENTRYPOINT ["/opt/entrypoint.sh"]
