FROM node:20-slim AS base
WORKDIR /app

FROM base AS builder
COPY package.json pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/service/package.json ./packages/service/
COPY packages/web/package.json ./packages/web/

RUN corepack enable pnpm && pnpm install --frozen-lockfile

COPY packages/shared ./packages/shared
COPY packages/service ./packages/service
COPY packages/web ./packages/web

RUN pnpm turbo run build --filter=@vulnhunt/service --filter=@vulnhunt/web

FROM base AS runner
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 vulnhunt
WORKDIR /app

COPY --from=builder --chown=vulnhunt:nodejs /app/packages/service/dist ./packages/service/dist
COPY --from=builder --chown=vulnhunt:nodejs /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder --chown=vulnhunt:nodejs /app/packages/web/dist ./public

USER vulnhunt
EXPOSE 8080

CMD ["node", "packages/service/dist/main.js"]
