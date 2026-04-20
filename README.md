# VulnHunt Service

AI-powered vulnerability scanning platform. Private deployment, offline-capable.

## Project Structure

```
vulnhunt-srv/
├── packages/
│   ├── shared/           Cross-process contracts (types, error codes, event schemas)
│   ├── service/          Node.js backend (Hono + WS + MCP + Docker orchestration)
│   ├── web/              React frontend (Vite + Tailwind + TanStack Query)
│   └── worker-bridge/    Node bridge inside worker containers (pi CLI ↔ HTTP/WS)
├── submodules/
│   └── youngflow/        Youngflow CLI (git submodule)
├── worker-assets/        Non-TS assets for worker Docker image
│   ├── entrypoint.sh     MODE-based dispatch
│   ├── scan-mode.sh
│   ├── chat-mode.sh
│   ├── report-mode.sh
│   └── bin/              youngflow binary (built separately, gitignored)
├── deploy/               Deployment assets
│   ├── docker-compose.yml
│   ├── dockerfiles/
│   └── .env.example
├── docs/                 Architecture and development guides
└── e2e/                  Playwright end-to-end tests
```

## Quickstart (Development)

```bash
# Prerequisites: Node 20+, pnpm 9+, Docker

# 1. Install dependencies
pnpm install

# 2. Start infrastructure
cp deploy/.env.example .env
docker compose -f deploy/docker-compose.yml up -d db minio

# 3. Build shared package
pnpm --filter @vulnhunt/shared build

# 4. Start service + frontend
pnpm dev
```

## submodules

```bash
# Initialize submodules after clone
git submodule update --init --recursive

# The vulnhunt-flow must be placed at:
# worker-assets/ — see docs/dev-guide.md for details
```

## Build

```bash
pnpm build           # Build all packages
pnpm test            # Run all tests
pnpm lint            # Lint all packages
```

## References

- Architecture: `docs/architecture.md`
- Dev Guide: `docs/dev-guide.md`
- API: `docs/api.md`
- Deployment: `docs/deployment.md`
