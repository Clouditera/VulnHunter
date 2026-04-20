FROM node:20-slim AS base
WORKDIR /opt/vulnhunt

# Install system dependencies for report generation
RUN apt-get update && apt-get install -y --no-install-recommends \
      git unzip curl ca-certificates jq \
      wkhtmltopdf \
      pandoc \
      fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

# MinIO client
RUN curl -sL https://dl.min.io/client/mc/release/linux-amd64/mc \
      -o /usr/local/bin/mc && chmod +x /usr/local/bin/mc

# pi CLI and MCP adapter
RUN npm install -g @mariozechner/pi-coding-agent pi-mcp-adapter

# youngflow binary (copied from local build in CI/release)
COPY worker-assets/bin/youngflow /usr/local/bin/youngflow
RUN chmod +x /usr/local/bin/youngflow

# vulnhunt flow assets (fixed in image)
COPY submodules/vulnhunt-flow /opt/vulnhunt/flows/vulnhunt

# worker-bridge bundle
COPY packages/worker-bridge/dist/bundle.js /opt/bridge/bundle.js

# entrypoint
COPY worker-assets/entrypoint.sh /opt/entrypoint.sh
RUN chmod +x /opt/entrypoint.sh

WORKDIR /workspace
ENTRYPOINT ["/opt/entrypoint.sh"]
