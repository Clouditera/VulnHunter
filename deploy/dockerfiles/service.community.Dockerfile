FROM node:22-slim AS base
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

RUN pnpm turbo run build --filter=@vulnhunter/service --filter=@vulnhunter/web
RUN pnpm deploy --filter=@vulnhunter/service --prod /prod/service

FROM base AS runner
RUN apt-get update && apt-get install -y --no-install-recommends \
      unzip zip ca-certificates git \
    && rm -rf /var/lib/apt/lists/*
# pi CLI for L4 deep verification (credential save lifecycle)
ARG PI_VERSION=0.83.0
RUN npm install -g @earendil-works/pi-coding-agent@$PI_VERSION
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 vulnhunter
WORKDIR /app

ARG VULNHUNTER_VERSION=unknown
ARG VULNHUNTER_BUILD_TIME=
ARG VULNHUNTER_GIT_COMMIT=
ARG YOUNGFLOW_VERSION=0.2.5

COPY --from=builder --chown=vulnhunter:nodejs /prod/service/node_modules ./node_modules
COPY --from=builder --chown=vulnhunter:nodejs /prod/service/package.json ./package.json
COPY --from=builder --chown=vulnhunter:nodejs /prod/service/package.json ./packages/service/package.json
COPY --from=builder --chown=vulnhunter:nodejs /prod/service/dist ./packages/service/dist
COPY --from=builder --chown=vulnhunter:nodejs /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder --chown=vulnhunter:nodejs /app/packages/web/dist-business ./public
COPY --chown=vulnhunter:nodejs scripts/ops/vulnforge-schema-migration.mjs ./vulnforge-schema-migration.mjs
RUN mkdir -p /app/node_modules/@vulnhunter && \
    ln -sf /app/packages/service /app/node_modules/@vulnhunter/service && \
    chown -h vulnhunter:nodejs /app/node_modules/@vulnhunter/service
RUN printf '{\n  "product": "vulnhunter",\n  "version": "%s",\n  "buildTime": "%s",\n  "gitCommit": "%s",\n  "youngflowVersion": "%s",\n  "licenseSchema": "v1"\n}\n' "$VULNHUNTER_VERSION" "$VULNHUNTER_BUILD_TIME" "$VULNHUNTER_GIT_COMMIT" "$YOUNGFLOW_VERSION" > /app/VERSION.json && \
    chown vulnhunter:nodejs /app/VERSION.json

# Customer runtime images should not expose TypeScript declarations or sourcemaps.
RUN find /app/packages -type f \( -name "*.map" -o -name "*.d.ts" -o -name "*.d.ts.map" \) -delete && \
    find /app/packages -type f -name "*.js" -exec sed -i '/^\/\/# sourceMappingURL=/d' {} + && \
    find /app/public -type f -name "*.map" -delete && \
    find /app/public -type f -name "*.js" -exec sed -i '/sourceMappingURL=/d' {} +

USER vulnhunter
EXPOSE 8080

CMD ["node", "packages/service/dist/main.js"]
