# Dependency license audit (coarse) — 2026-08-03

**Scope:** production + transitive packages resolved by `pnpm-lock.yaml` in open-source tree `Clouditera/VulnHunter` @ main (post open-core split).  
**Method:** enumerate `node_modules/.pnpm/**/package.json` `license` fields after `pnpm install --frozen-lockfile`.  
**Project license:** AGPL-3.0-only.

## Summary

| Result | Detail |
|--------|--------|
| Packages sampled | ~437 unique name@version |
| Dominant licenses | MIT (~355), ISC (~49), Apache-2.0 (~10), BSD-2/3 (~10) |
| Copyleft / proprietary in deps | **None found** (no GPL/AGPL/SSPL/BUSL/UNLICENSED production deps) |
| AGPL compatibility (practical) | **OK for open-source distribution** — dependencies are permissive; combining under AGPL-3.0 is standard |

## Histogram (top)

```
355  MIT
 49  ISC
 10  Apache-2.0
  8  BSD-3-Clause
  5  BlueOak-1.0.0
  2  Unlicense
  2  BSD-2-Clause
  1  Python-2.0
  1  CC-BY-4.0
  1  MIT-0
  (+ a few MIT packages declaring license as {type,url})
```

## Direct runtime dependencies (workspace packages)

| Package | Notable direct deps (license family) |
|---------|--------------------------------------|
| `@vulnhunter/service` | hono, @hono/node-server, postgres, minio, dockerode, bcrypt, pino, ws, zod, mcp sdk — MIT/Apache-class |
| `@vulnhunter/web` | react, react-dom, react-router, tanstack-query, react-markdown — MIT |
| `@vulnhunter/shared` | (workspace types/utils) |
| `@vulnhunter/worker-bridge` | thin bridge |

## Notes / follow-ups

1. **Not a legal opinion.** This is an automated coarse scan for release hygiene before Public visibility.
2. Re-run after major dependency bumps:  
   `pnpm install &&` re-scan `.pnpm` license fields (or `license-checker` / `licensee`).
3. **Native / bundled binaries** (Docker base images, YoungFlow binary, system packages in Dockerfiles) are outside this npm scan — track separately in image SBOM if required by customers.
4. Optional: add CI job `license-checker --production --onlyAllow 'MIT;ISC;Apache-2.0;BSD-*;BlueOak-*;Unlicense;MIT-0;Python-2.0;CC-BY-4.0'`.

## Verdict for open-source go-live

**No blocking third-party license conflicts identified** for publishing this repository under AGPL-3.0 with current lockfile.
