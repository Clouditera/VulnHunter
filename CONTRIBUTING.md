# Contributing to VulnHunter

Thanks for your interest in improving VulnHunter. This guide covers how to propose changes to the **open-source** tree (AGPL-3.0).

## Before you start

1. Search existing issues/PRs to avoid duplicates.
2. For large features or architecture changes, open an issue first and wait for maintainer feedback.
3. **Security vulnerabilities:** do **not** file a public issue — see [SECURITY.md](./SECURITY.md).

## Development setup

Requirements: **Node.js ≥ 20**, **pnpm ≥ 9**, Docker (for full stack).

```bash
git clone https://github.com/Clouditera/VulnHunter.git
cd VulnHunter
pnpm install
pnpm --filter @vulnhunter/shared build
pnpm --filter @vulnhunter/service build
pnpm --filter @vulnhunter/web build
```

Useful commands:

| Command | Purpose |
|---------|---------|
| `pnpm --filter @vulnhunter/service test` | Service unit tests |
| `pnpm --filter @vulnhunter/service exec tsc --noEmit` | Service typecheck |
| `pnpm --filter @vulnhunter/web exec tsc --noEmit` | Web typecheck (baseline may include known non-blocking errors — do not add new ones) |
| `pnpm lint` | Biome check |

Deploy/package scripts live under `deploy/` and `scripts/`. Offline release builds need Docker images as documented in `deploy/README.md` (or the release guide under `docs/`).

## Pull request process

1. Fork and branch from `main` (`feature/…` or `fix/…`).
2. Keep PRs focused; separate refactors from behavior changes when practical.
3. Add or update tests for bug fixes and non-trivial logic.
4. Ensure local typecheck/tests relevant to your change pass.
5. Fill in the PR description: motivation, what changed, how tested.
6. **CLA:** you must accept the Contributor License Agreement (below).

Maintainers may request changes, squash-merge, or ask you to rebase onto latest `main`.

## Contributor License Agreement (CLA)

VulnHunter is dual-distributed: **AGPL-3.0** open source and separate **commercial** offerings. To keep that possible, every external contribution requires a CLA.

Full text: **[CLA.md](./CLA.md)**.

### How to sign

On your pull request, add a comment:

```text
I have read the CLA.md and I agree to its terms for my contributions.
```

### CLA bot (maintainers)

We intend to enforce CLA collection with one of:

| Option | Notes |
|--------|--------|
| [CLA Assistant](https://cla-assistant.io/) | GitHub App; stores signatures; free for public repos |
| [github-cla-bot](https://github.com/cla-assistant/github-cla-bot) / org equivalent | Self-hosted or org-managed |
| Manual checklist | Interim: maintainer verifies the PR comment before merge |

Until a bot is wired on the GitHub org, **maintainers must not merge external PRs without an explicit CLA comment** matching `CLA.md`.

## Coding guidelines

- TypeScript throughout; prefer explicit types on exported APIs.
- Follow existing package layout (`packages/service`, `packages/web`, `packages/shared`, `packages/worker-bridge`).
- Do not commit secrets, real credentials, customer data, or private keys. Use fixtures with obvious fake values.
- Do not add dependencies without a short rationale in the PR (license must be AGPL-compatible for distribution — prefer MIT/BSD/Apache-2.0/ISC).
- UI copy: keep community edition free of proprietary SaaS upsell language unless behind edition gates already used in-tree.

## What belongs elsewhere

Commercial / SaaS-only product modules are **not** developed in this repository. Contributions that only make sense for private enterprise packaging should be discussed with maintainers before work starts.

## License

By contributing, you agree that your contributions are licensed under the terms described in [CLA.md](./CLA.md) and distributed in the open-source tree under [LICENSE](./LICENSE) (AGPL-3.0).
