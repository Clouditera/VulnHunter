import { describe, expect, it } from "vitest";
import {
  getTaskNameError,
  normalizeTaskName,
  truncateTaskName,
} from "../src/features/tasks/task-name.js";

describe("task name", () => {
  it("trims surrounding spaces and accepts the supported characters", () => {
    expect(normalizeTaskName("  扫描_Task-1（正式）  ")).toBe("扫描_Task-1（正式）");
    expect(getTaskNameError("扫描_Task-1(test)")).toBeNull();
  });

  it("requires 1-64 characters after trimming", () => {
    expect(getTaskNameError("   ")).toBe("required");
    expect(getTaskNameError("中".repeat(64))).toBeNull();
    expect(getTaskNameError("中".repeat(65))).toBe("too_long");
  });

  it("rejects unsupported characters", () => {
    expect(getTaskNameError("scan task")).toBe("invalid_characters");
    expect(getTaskNameError("scan@task")).toBe("invalid_characters");
  });

  it("shows at most 32 characters and preserves the full name for hover", () => {
    expect(truncateTaskName("中".repeat(32))).toEqual({ text: "中".repeat(32), truncated: false });
    expect(truncateTaskName("中".repeat(33))).toEqual({
      text: `${"中".repeat(32)}…`,
      truncated: true,
    });
  });
});
