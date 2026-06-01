FROM node:20-slim AS base
WORKDIR /app

FROM base AS builder
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/service/package.json ./packages/service/
COPY packages/web/package.json ./packages/web/

RUN corepack enable pnpm && pnpm install --frozen-lockfile

COPY packages/shared ./packages/shared
COPY packages/service ./packages/service
COPY packages/web ./packages/web

RUN pnpm turbo run build --filter=@vulnagent/service --filter=@vulnagent/web
RUN pnpm deploy --filter=@vulnagent/service --prod /prod/service

FROM base AS runner
RUN apt-get update && apt-get install -y --no-install-recommends \
      unzip zip ca-certificates git \
    && rm -rf /var/lib/apt/lists/*
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 vulnagent
WORKDIR /app

ARG VULNAGENT_VERSION=unknown
ARG VULNAGENT_BUILD_TIME=
ARG VULNAGENT_GIT_COMMIT=
ARG YOUNGFLOW_VERSION=0.2.5

COPY --from=builder --chown=vulnagent:nodejs /prod/service/node_modules ./node_modules
COPY --from=builder --chown=vulnagent:nodejs /prod/service/package.json ./package.json
COPY --from=builder --chown=vulnagent:nodejs /prod/service/dist ./packages/service/dist
COPY --from=builder --chown=vulnagent:nodejs /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder --chown=vulnagent:nodejs /app/packages/web/dist ./public
RUN printf '{\n  "product": "vulnagent",\n  "version": "%s",\n  "buildTime": "%s",\n  "gitCommit": "%s",\n  "youngflowVersion": "%s",\n  "licenseSchema": "v1"\n}\n' "$VULNAGENT_VERSION" "$VULNAGENT_BUILD_TIME" "$VULNAGENT_GIT_COMMIT" "$YOUNGFLOW_VERSION" > /app/VERSION.json && \
    chown vulnagent:nodejs /app/VERSION.json

# DeVeye toolkit files for user download (~190MB: 3 platform binaries + extension)
COPY --chown=vulnagent:nodejs submodules/DevEye/packages/cli/binaries/index-linux /opt/deveye-toolkits/binaries/index-linux
COPY --chown=vulnagent:nodejs submodules/DevEye/packages/cli/binaries/index-win.exe /opt/deveye-toolkits/binaries/index-win.exe
COPY --chown=vulnagent:nodejs submodules/DevEye/packages/cli/binaries/index-macos /opt/deveye-toolkits/binaries/index-macos
COPY --chown=vulnagent:nodejs submodules/DevEye/packages/chrome-extension/dist /opt/deveye-toolkits/extension-dist
COPY --chown=vulnagent:nodejs worker-assets/deveye-toolkit/setup.sh /opt/deveye-toolkits/setup/setup.sh
COPY --chown=vulnagent:nodejs worker-assets/deveye-toolkit/setup.bat /opt/deveye-toolkits/setup/setup.bat

USER vulnagent
EXPOSE 8080

CMD ["node", "packages/service/dist/main.js"]
