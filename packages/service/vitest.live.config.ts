import { defineConfig } from "vitest/config";

// l4-live bucket: tests that spawn real subprocesses and/or hit the real
// network. NOT part of the merge-gate unit suite — run at release-gate time
// (QA) via: pnpm --filter @vulnhunter/service test:live
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/live/**/*.test.ts"],
    timeout: 120_000,
    minWorkers: 1,
    maxWorkers: 1,
  },
});
