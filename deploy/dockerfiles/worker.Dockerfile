FROM node:22-slim AS base
ENV HOME=/root
WORKDIR /opt/vulnhunter

# pi version pin (single source: packages/shared/src/pi.version.ts)
ARG PI_VERSION=0.83.0

# System dependencies (python3 + pyyaml needed by feature-aggregator, project-profiler;
# pandoc + openpyxl for report docx/xlsx export — fish 2026-07-27)
RUN apt-get update && apt-get install -y --no-install-recommends \
      git openssh-client unzip zip curl ca-certificates jq \
      python3 python3-yaml python3-pip pandoc \
    && pip3 install --no-cache-dir --break-system-packages openpyxl \
    && rm -rf /var/lib/apt/lists/* \
    && ssh -V \
    && command -v scp >/dev/null \
    && command -v pandoc >/dev/null \
    && python3 -c "import openpyxl"

# pi CLI (youngflow spawns it for each stage). Pin the fork validated by VulnForge.
# The mcp adapter is installed with build-time HOME=/root, then RELOCATED to a
# neutral world-readable path: de-identified workers get HOME=/workspace/.home
# and cannot read /root (700) — the bridge passes the extension explicitly via
# `pi -e $PI_MCP_ADAPTER_PATH` (main.ts), so no pi-side registry needs updating.
# The whole node_modules tree moves with it (sibling deps like @hono resolve
# from the package's own tree).
RUN npm install -g @earendil-works/pi-coding-agent@$PI_VERSION \
    && pi install npm:pi-mcp-adapter \
    && mkdir -p /opt/vulnhunter/pi-mcp-adapter \
    && mv "$HOME/.pi/agent/npm/node_modules" /opt/vulnhunter/pi-mcp-adapter/node_modules
ENV PI_MCP_ADAPTER_PATH=/opt/vulnhunter/pi-mcp-adapter/node_modules/pi-mcp-adapter

# youngflow — self-contained release binary (v0.7.0)
COPY submodules/youngflow/release/youngflow-linux-x64 /usr/local/bin/youngflow
RUN chmod +x /usr/local/bin/youngflow \
    && youngflow --version

# VulnForge 2.0 scan flow assets (separate from youngflow submodule).
# Keep these values in the image so support/QA can prove the exact flow baseline.
ARG VULNFORGE_VERSION=2.0-12-g72c4998
ARG VULNFORGE_COMMIT=72c499876116496710dacc7b20563c6caf628d59
LABEL org.opencontainers.image.vulnforge.version=$VULNFORGE_VERSION \
      org.opencontainers.image.vulnforge.revision=$VULNFORGE_COMMIT
COPY flows/vulnforge /opt/vulnhunter/flows/vulnforge
COPY flows/vulnforge-timeout /opt/vulnhunter/flows/vulnforge-timeout
RUN printf '{\n  "version": "%s",\n  "commit": "%s"\n}\n' \
      "$VULNFORGE_VERSION" "$VULNFORGE_COMMIT" \
      > /opt/vulnhunter/VULNFORGE_VERSION.json
RUN cd /opt/vulnhunter/flows/vulnforge/extensions/output-contract \
    && npm install --omit=dev --no-audit --no-fund \
    && npm install --omit=dev --no-audit --no-fund @earendil-works/pi-coding-agent@$PI_VERSION
RUN cd /opt/vulnhunter/flows/vulnforge/extensions/code-coverage-viewer \
    && npm init -y >/dev/null \
    && npm install --omit=dev --no-audit --no-fund \
      @mariozechner/pi-coding-agent@npm:@earendil-works/pi-coding-agent@$PI_VERSION \
      @mariozechner/pi-ai@npm:@earendil-works/pi-ai@$PI_VERSION
RUN cd /opt/vulnhunter/flows/vulnforge/extensions/workspace-diff \
    && npm init -y >/dev/null \
    && npm install --omit=dev --no-audit --no-fund \
      @earendil-works/pi-coding-agent@$PI_VERSION \
      @earendil-works/pi-ai@$PI_VERSION
# pi-web-access (nested submodule, pinned a1135b8 in VulnForge-Flow): web
# search/extract for research+hunt stages. 7 runtime deps + pi peerDeps
# (mirrors output-contract/code-coverage-viewer install shape).
RUN cd /opt/vulnhunter/flows/vulnforge/extensions/pi-web-access \
    && npm install --omit=dev --no-audit --no-fund \
    && npm install --omit=dev --no-audit --no-fund \
      @earendil-works/pi-coding-agent@$PI_VERSION \
      @earendil-works/pi-ai@$PI_VERSION
COPY flows/prepare /opt/vulnhunter/flows/prepare
COPY packages/service/src/features/prepare/schemas/source-manifest-v1.schema.json /opt/vulnhunter/flows/prepare/schemas/source-manifest-v1.schema.json
# output-contract for prepare (task-b451d2e9): extension code single-sourced from
# vulnforge submodule; prepare-owned contracts.json overlays the vulnforge rules.
# No runtime symlink — Docker COPY would leave a dangling link.
RUN mkdir -p /opt/vulnhunter/flows/prepare/extensions/output-contract \
    && cp /opt/vulnhunter/flows/prepare/extensions/output-contract/contracts.json \
      /tmp/prepare-output-contract.contracts.json \
    && cp -a /opt/vulnhunter/flows/vulnforge/extensions/output-contract/. \
      /opt/vulnhunter/flows/prepare/extensions/output-contract/ \
    && cp /tmp/prepare-output-contract.contracts.json \
      /opt/vulnhunter/flows/prepare/extensions/output-contract/contracts.json \
    && cd /opt/vulnhunter/flows/prepare/extensions/output-contract \
    && npm install --omit=dev --no-audit --no-fund \
    && npm install --omit=dev --no-audit --no-fund @earendil-works/pi-coding-agent@$PI_VERSION \
    && test -f /opt/vulnhunter/flows/prepare/extensions/output-contract/index.ts \
    && test -f /opt/vulnhunter/flows/prepare/extensions/output-contract/contracts.json \
    && test -d /opt/vulnhunter/flows/prepare/extensions/output-contract/node_modules \
    && grep -q '"prepare"' /opt/vulnhunter/flows/prepare/extensions/output-contract/contracts.json
RUN youngflow /opt/vulnhunter/flows/prepare/flow.prepare.yaml --list-stages >/tmp/prepare-stages.txt \
    && grep -qE '^  prepare[[:space:]]' /tmp/prepare-stages.txt
RUN test -f /opt/vulnhunter/flows/vulnforge/extensions/code-coverage-tracker/index.ts \
    && test -f /opt/vulnhunter/flows/vulnforge/extensions/code-coverage-viewer/index.ts \
    && test -f /opt/vulnhunter/flows/vulnforge/extensions/output-contract/contracts.json \
    && test -f /opt/vulnhunter/flows/vulnforge/extensions/workspace-diff/index.ts \
    && test -f /opt/vulnhunter/flows/vulnforge/extensions/pi-web-access/index.ts \
    && test -d /opt/vulnhunter/flows/vulnforge/extensions/pi-web-access/node_modules \
    && test -L /opt/vulnhunter/flows/vulnforge-timeout/schemas \
    && test "$(readlink /opt/vulnhunter/flows/vulnforge-timeout/schemas)" = ../vulnforge/schemas \
    && test "$(realpath /opt/vulnhunter/flows/vulnforge-timeout/schemas)" = /opt/vulnhunter/flows/vulnforge/schemas \
    && test "$(sha256sum /opt/vulnhunter/flows/vulnforge-timeout/schemas/audit-completion.schema.yaml | awk '{print $1}')" = "$(sha256sum /opt/vulnhunter/flows/vulnforge/schemas/audit-completion.schema.yaml | awk '{print $1}')" \
    && test "$(sha256sum /opt/vulnhunter/flows/vulnforge-timeout/schemas/audit-report.schema.yaml | awk '{print $1}')" = "$(sha256sum /opt/vulnhunter/flows/vulnforge/schemas/audit-report.schema.yaml | awk '{print $1}')" \
    && printf '{"providers":{}}\n' > /opt/vulnhunter/flows/vulnforge/models.json \
    && youngflow /opt/vulnhunter/flows/vulnforge/flow.audit.yaml --list-stages >/tmp/vulnforge-stages.txt \
    && youngflow /opt/vulnhunter/flows/vulnforge-timeout/flow.timeout-finalize.yaml --list-stages >/tmp/vulnforge-timeout-stages.txt \
    && rm -f /opt/vulnhunter/flows/vulnforge/models.json \
    && grep -qE '^  complete[[:space:]]' /tmp/vulnforge-stages.txt \
    && grep -qE '^  report[[:space:]]' /tmp/vulnforge-timeout-stages.txt \
    && youngflow /opt/vulnhunter/flows/vulnforge/flow.audit.yaml --help >/tmp/vulnforge-help.txt \
    && grep -q -- '--user-instr <value>' /tmp/vulnforge-help.txt \
    && grep -q -- '--sandbox-cfg <value>' /tmp/vulnforge-help.txt
COPY flows/vulnhunter-report /opt/vulnhunter/flows/vulnhunter-report

# De-identified workers (non-root) treat flow dirs as per-run scratch:
# scan/report regenerate models.json + .env there, and youngflow materializes
# .pi-agent/ (PI_CODING_AGENT_DIR) under flowDir for EVERY flow — prepare and
# vulnforge-timeout included (QA-caught: prepare EACCES mkdir .pi-agent).
# The youngflow flowDir anchor is engine-owned (dist/model-config.js), so the
# in-repo fix is uniform writability. Containers are single-use; nothing
# secret persists in the image.
RUN chmod 0777 /opt/vulnhunter/flows/vulnforge /opt/vulnhunter/flows/vulnforge-timeout \
    /opt/vulnhunter/flows/prepare /opt/vulnhunter/flows/vulnhunter-report

# Bake the ssh drop-in at build time: it is a static one-liner (Include the
# tmpfs config), so runtime injection never touches /etc — de-identified
# workers (uid != 0) can't write there (QA-caught continue-scan EACCES).
# ssh silently skips the Include when the tmpfs config is absent (static
# tasks) — verified: ssh -G exit 0 both ways.
RUN mkdir -p /etc/ssh/ssh_config.d \
    && printf 'Include /run/vulnhunter/ssh/config\n' > /etc/ssh/ssh_config.d/99-vulnhunter.conf

# Worker bridge (for chat/report modes)
COPY packages/worker-bridge/dist/bundle.js /opt/bridge/bundle.js
COPY packages/worker-bridge/package.json /opt/bridge/package.json
RUN cd /opt/bridge && npm install --omit=dev --ignore-scripts 2>/dev/null || true

# Worker scripts
COPY worker-assets/entrypoint.sh /opt/entrypoint.sh
COPY worker-assets/scan-mode.sh /opt/scan-mode.sh
COPY worker-assets/chat-mode.sh /opt/chat-mode.sh
COPY worker-assets/report-mode.sh /opt/report-mode.sh
COPY worker-assets/prepare-mode.sh /opt/prepare-mode.sh
COPY worker-assets/prepare-result-postflight.py /opt/prepare-result-postflight.py
COPY worker-assets/run-with-deadline.py /opt/run-with-deadline.py
COPY worker-assets/timeout-finalize-artifacts.py /opt/timeout-finalize-artifacts.py
RUN chmod +x /opt/entrypoint.sh /opt/scan-mode.sh /opt/chat-mode.sh /opt/report-mode.sh /opt/prepare-mode.sh /opt/prepare-result-postflight.py \
    /opt/run-with-deadline.py /opt/timeout-finalize-artifacts.py

WORKDIR /workspace
ENTRYPOINT ["/opt/entrypoint.sh"]
