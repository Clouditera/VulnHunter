import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts"],
    // l4-live bucket (real subprocess + real network) lives in test/live/ and
    // runs via vitest.live.config.ts at release-gate time — unit suite must be
    // hermetic (architect 2026-08-04, parallel flake task-647dcbfe).
    exclude: ["test/live/**", "**/node_modules/**"],
    timeout: 15000,
    // Merge-gate runs share this machine with docker builds + tsc + vite;
    // cap worker fan-out to blunt load spikes (worker-level flake defense).
    minWorkers: 1,
    maxWorkers: 4,
    // junit retention: next flake lands with its exact error text.
    reporters: ["default", "junit"],
    outputFile: { junit: "test-results/junit.xml" },
  },
});
