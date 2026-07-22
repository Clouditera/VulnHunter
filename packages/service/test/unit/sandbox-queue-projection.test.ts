import { describe, expect, it } from "vitest";
import { projectSandboxQueue } from "../../src/features/sandboxes/capacity.js";

describe("projectSandboxQueue", () => {
  it("returns waiting when next_attempt_at is in the future", () => {
    const next = new Date(Date.now() + 60_000).toISOString();
    const q = projectSandboxQueue({
      sandbox_alloc: { attempts: 2, next_attempt_at: next, last_error: "capacity" },
    });
    expect(q).toEqual({ waiting: true, reason: "capacity", since: null, attempts: 2 });
  });

  it("returns null when no sandbox_alloc", () => {
    expect(projectSandboxQueue({})).toBeNull();
    expect(projectSandboxQueue(null)).toBeNull();
  });

  it("maps quota reason", () => {
    const next = new Date(Date.now() + 60_000).toISOString();
    const q = projectSandboxQueue({
      sandbox_alloc: { attempts: 1, next_attempt_at: next, last_error: "quota" },
    });
    expect(q?.reason).toBe("quota");
  });
});
