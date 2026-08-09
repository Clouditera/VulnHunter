import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * task run_count (fish 2026-08-09 「共 N 段」):
 * - migration 054 adds column
 * - terminal completion increments alongside total_duration_ms
 * - restart zeroes
 */

const root = resolve(__dirname, "../../../..");

describe("task run_count (共 N 段)", () => {
  it("migration 054 adds run_count INT DEFAULT 0", () => {
    const sql = readFileSync(
      resolve(root, "packages/service/src/infra/db/migrations/054_task_run_count.sql"),
      "utf8",
    );
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS run_count INT NOT NULL DEFAULT 0/);
  });

  it("updateTaskState terminal path increments run_count", () => {
    const src = readFileSync(
      resolve(root, "packages/service/src/features/tasks/storage.ts"),
      "utf8",
    );
    expect(src).toMatch(/run_count = COALESCE\(run_count, 0\) \+ 1/);
    // same block as total_duration_ms accumulation
    const idxDur = src.indexOf("total_duration_ms = COALESCE(total_duration_ms, 0)");
    const idxRun = src.indexOf("run_count = COALESCE(run_count, 0) + 1");
    expect(idxDur).toBeGreaterThan(0);
    expect(idxRun).toBeGreaterThan(idxDur);
    expect(idxRun - idxDur).toBeLessThan(200);
  });

  it("resetTaskForRestart zeroes run_count with total_duration_ms", () => {
    const src = readFileSync(
      resolve(root, "packages/service/src/features/tasks/storage.ts"),
      "utf8",
    );
    expect(src).toMatch(/total_duration_ms = 0,\s*run_count = 0,/s);
  });

  it("TaskSummary exposes optional run_count", () => {
    const src = readFileSync(resolve(root, "packages/shared/src/api/task.ts"), "utf8");
    expect(src).toMatch(/run_count\?: number/);
  });
});
