# VulnHunt Development Guide

**Reference**: Architecture discussion (8 scenes), Project Structure spec
**Enforced via**: Biome lint rules + code review

---

## Core Principles

1. **Organize by domain, not by layer** — `features/tasks/`, `features/findings/`, etc. Not `controllers/ services/ repositories/`
2. **Cross-process contracts in shared only** — Types, error codes, event schemas defined ONCE in `@vulnhunt/shared`
3. **Dependencies flow down, never sideways** — `shared` has zero runtime deps; features don't import each other's internals
4. **Separate publishable units** — `service`, `web`, `worker-bridge` are three independent deliverables
5. **Config separate from code** — Dockerfiles, compose, SQL migrations, i18n dicts live in `deploy/` or package `resources/`

---

## Development Red Lines

| ❌ Forbidden | ✅ Correct | Reason |
|---|---|---|
| Feature imports another feature's internal file | Import only from `../other-feature` (index.ts) | Boundary enforcement |
| Business logic in `routes.ts` | Business logic in `service.ts`; routes = IO + validation + call service | Separation of concerns |
| `infra/` importing from `features/` | `features/` → `infra/` only | Dependency direction |
| Frontend `fetch("/api/tasks")` literal | Use `@vulnhunt/shared` DTO + `api-client.ts` | Type safety |
| `throw new Error("some string")` | `throw new AppError("ERR_TASK_NOT_FOUND")` | Use shared error codes |
| Sensitive fields in logs | pino `redact` config covers api_key/password/session_token | Security |
| `SELECT * WHERE task_id = ?` without `tenant_id` | Always filter by `tenant_id` for business data | Multi-tenant readiness |
| Define API/WS types outside `shared` | Add to `packages/shared/src/api/` or `events/` | Prevent schema drift |
| Runtime dependency in `shared/package.json` | `shared` devDependencies only | Keep frontend bundle clean |
| Circular dependencies (package or feature level) | Check with `madge` in CI | Future maintainability |
| `any` type (except generic constraints) | Explicit types everywhere | TypeScript strict mode |
| TODO without issue reference | `// TODO(#123): ...` | Track tech debt |

---

## Feature Module Standard Structure

Every domain feature follows this layout:

```
features/<domain>/
├── routes.ts       Hono router — HTTP handlers only (no business logic)
├── service.ts      Business logic (no HTTP, no direct DB calls)
├── storage.ts      DB access layer (SQL queries, drizzle models)
├── events.ts       (optional) WS subscriptions / event emitters
├── types.ts        (optional) Feature-internal types; public types go in @vulnhunt/shared
└── index.ts        Public exports: router, service instance, types
```

**Rule**: Other features ONLY import from `../other-feature` — never `../other-feature/storage.ts` etc.

---

## Error Handling

All errors use shared `ERROR_CATALOG`:

```typescript
// In service.ts:
import { type ErrorCode } from "@vulnhunt/shared";

class AppError extends Error {
  constructor(public readonly code: ErrorCode, public readonly context?: Record<string, unknown>) {
    super(code);
  }
}

// In middleware/error-handler.ts:
import { ERROR_CATALOG } from "@vulnhunt/shared";

// Catch AppError → format as ApiError response
```

---

## Multi-tenant Rules

- All business tables have `tenant_id uuid` column
- v1.0: single default tenant (id: `00000000-0000-0000-0000-000000000001`)
- Every `SELECT`/`INSERT`/`UPDATE`/`DELETE` on business tables includes `WHERE tenant_id = $tenantId`
- Session includes `tenant_id` — middleware injects into request context
- v1.x: add UI for tenant management and flip the switch

---

## submodules

- `submodules/youngflow` — Youngflow CLI (github.com/Clouditera/Youngflow)
- The `vulnhunt-flow` directory lives at `~/dev/llm/youngflow/flows/vulnhunt/` locally
  - For the worker image build, copy it to `worker-assets/` or reference via build script
  - `scripts/build-worker-bin.sh` handles the copy

---

## Dependency Graph

```
shared (zero runtime deps)
    ↑           ↑           ↑
   web        service   worker-bridge
```

No lateral dependencies between packages.

---

## Testing Strategy

| Layer | Location | Tool | What |
|---|---|---|---|
| Unit | `packages/*/test/unit/` | Vitest | Pure functions, service.ts methods |
| Integration | `packages/service/test/integration/` | Vitest + testcontainers | API routes with real PG + MinIO |
| E2E | `e2e/` | Playwright | Browser-level user journeys |

Run tests:
```bash
pnpm test                     # all packages
pnpm --filter @vulnhunt/service test   # specific package
```

---

## Commit Convention

```
feat(tasks): add pause/resume API
fix(workers): handle docker socket timeout on reconcile
chore(shared): add ERR_SKILL_NOT_FOUND error code
docs(dev-guide): add tenant_id rules
```

Conventional commits. Scope = feature domain or package name.
