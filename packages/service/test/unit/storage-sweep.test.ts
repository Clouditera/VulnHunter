import { describe, expect, it } from "vitest";
import { classifyOrphan, SWEEP_PREFIXES } from "../../src/features/admin/storage-sweep.js";

const ids = {
  tasks: new Set(["task-1"]),
  sessions: new Set(["sess-1"]),
  reports: new Set(["rep-1"]),
};

describe("classifyOrphan", () => {
  it("task prefixes: orphan only when task row is gone", () => {
    expect(classifyOrphan("code-packages/", "code-packages/task-1/src.zip", ids)).toBeNull();
    expect(classifyOrphan("code-packages/", "code-packages/task-gone/src.zip", ids)).toBe("orphan");
    expect(classifyOrphan("scan-outputs/", "scan-outputs/task-1/out/a.json", ids)).toBeNull();
    expect(classifyOrphan("scan-outputs/", "scan-outputs/task-gone/out/a.json", ids)).toBe("orphan");
  });

  it("chat prefixes: orphan only when session row is gone", () => {
    expect(classifyOrphan("chat-artifacts/", "chat-artifacts/sess-1/ab.pdf", ids)).toBeNull();
    expect(classifyOrphan("chat-artifacts/", "chat-artifacts/sess-gone/ab.pdf", ids)).toBe("orphan");
    expect(classifyOrphan("chat-sessions/", "chat-sessions/sess-1/session.jsonl", ids)).toBeNull();
    expect(classifyOrphan("chat-sessions/", "chat-sessions/sess-gone/session.jsonl", ids)).toBe("orphan");
  });

  it("user-reports: orphan when task gone OR report gone (report granularity)", () => {
    expect(classifyOrphan("user-reports/", "user-reports/task-1/rep-1/primary.md", ids)).toBeNull();
    // report row deleted but task still exists -> orphan (user-delete cascade case)
    expect(classifyOrphan("user-reports/", "user-reports/task-1/rep-gone/primary.md", ids)).toBe("orphan");
    expect(classifyOrphan("user-reports/", "user-reports/task-gone/rep-1/primary.md", ids)).toBe("orphan");
  });

  it("unknown prefix never classifies", () => {
    expect(classifyOrphan("sandboxes/", "sandboxes/anything", ids)).toBeNull();
  });

  it("key without owner segment is left alone", () => {
    expect(classifyOrphan("code-packages/", "code-packages/", ids)).toBeNull();
  });

  it("sweep prefix list excludes every sandbox-plane prefix by construction", () => {
    for (const p of SWEEP_PREFIXES) {
      expect(p.startsWith("sandbox")).toBe(false);
    }
  });
});
