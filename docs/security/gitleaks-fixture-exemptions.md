# Gitleaks fixture exemptions (C1-a)

Full-history scan (`gitleaks detect --log-opts=--all`, 2026-08-03) reported **13** hits, all RuleID `private-key`.

| Path | Reason |
|------|--------|
| `packages/service/src/features/sandboxes/ssh-keys.ts` | Generates OpenSSH private key PEM headers in code comments / template strings for task SSH |
| `packages/service/test/unit/h1-ssh-inject.test.ts` | Unit fixtures intentionally embed `BEGIN … PRIVATE KEY` markers for leak-scan tests |

No live customer secrets or production keys were found. These paths are retained under AGPL as test/generator code.
