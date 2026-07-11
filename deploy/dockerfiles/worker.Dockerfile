FROM node:22-slim AS base
ENV HOME=/root
WORKDIR /opt/vulnagent

# System dependencies (python3 + pyyaml needed by feature-aggregator, project-profiler)
RUN apt-get update && apt-get install -y --no-install-recommends \
      git openssh-client unzip zip curl ca-certificates jq \
      python3 python3-yaml \
    && rm -rf /var/lib/apt/lists/* \
    && ssh -V \
    && command -v scp >/dev/null

# pi CLI (youngflow spawns it for each stage). Pin the fork validated by VulnForge.
RUN npm install -g @earendil-works/pi-coding-agent@0.79.6 \
    && pi install npm:pi-mcp-adapter

# youngflow — self-contained release binary (v0.3.8)
COPY submodules/youngflow/release/youngflow-linux-x64 /usr/local/bin/youngflow
RUN chmod +x /usr/local/bin/youngflow \
    && youngflow --version

# VulnForge 2.0 scan flow assets (separate from youngflow submodule).
# Keep these values in the image so support/QA can prove the exact flow baseline.
ARG VULNFORGE_VERSION=2.0
ARG VULNFORGE_COMMIT=058da50be533b4605ff2e1614cef77b5c2d936bd
LABEL org.opencontainers.image.vulnforge.version=$VULNFORGE_VERSION \
      org.opencontainers.image.vulnforge.revision=$VULNFORGE_COMMIT
COPY flows/vulnforge /opt/vulnagent/flows/vulnforge
RUN printf '{\n  "version": "%s",\n  "commit": "%s"\n}\n' \
      "$VULNFORGE_VERSION" "$VULNFORGE_COMMIT" \
      > /opt/vulnagent/VULNFORGE_VERSION.json
RUN cd /opt/vulnagent/flows/vulnforge/extensions/output-contract \
    && npm install --omit=dev --no-audit --no-fund \
    && npm install --omit=dev --no-audit --no-fund @earendil-works/pi-coding-agent@0.79.6
RUN cd /opt/vulnagent/flows/vulnforge/extensions/code-coverage-viewer \
    && npm init -y >/dev/null \
    && npm install --omit=dev --no-audit --no-fund \
      @mariozechner/pi-coding-agent@npm:@earendil-works/pi-coding-agent@0.79.6 \
      @mariozechner/pi-ai@npm:@earendil-works/pi-ai@0.79.6
RUN cd /opt/vulnagent/flows/vulnforge/extensions/workspace-diff \
    && npm init -y >/dev/null \
    && npm install --omit=dev --no-audit --no-fund \
      @earendil-works/pi-coding-agent@0.79.6 \
      @earendil-works/pi-ai@0.79.6
COPY flows/prepare /opt/vulnagent/flows/prepare
RUN cd /opt/vulnagent/flows/prepare/extensions/prepare-tools \
    && npm ci --omit=dev --ignore-scripts --no-audit --no-fund
RUN test -f /opt/vulnagent/flows/prepare/extensions/prepare-tools/index.ts \
    && youngflow /opt/vulnagent/flows/prepare/flow.prepare.yaml --list-stages >/tmp/prepare-stages.txt \
    && grep -qE '^  prepare[[:space:]]' /tmp/prepare-stages.txt
RUN test -f /opt/vulnagent/flows/vulnforge/extensions/code-coverage-tracker/index.ts \
    && test -f /opt/vulnagent/flows/vulnforge/extensions/code-coverage-viewer/index.ts \
    && test -f /opt/vulnagent/flows/vulnforge/extensions/output-contract/contracts.json \
    && test -f /opt/vulnagent/flows/vulnforge/extensions/workspace-diff/index.ts \
    && youngflow /opt/vulnagent/flows/vulnforge/flow.audit.yaml --list-stages >/tmp/vulnforge-stages.txt \
    && grep -qE '^  complete[[:space:]]' /tmp/vulnforge-stages.txt \
    && youngflow /opt/vulnagent/flows/vulnforge/flow.audit.yaml --help >/tmp/vulnforge-help.txt \
    && grep -q -- '--user-instr <value>' /tmp/vulnforge-help.txt \
    && grep -q -- '--sandbox-cfg <value>' /tmp/vulnforge-help.txt
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
