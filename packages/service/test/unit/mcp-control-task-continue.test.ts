import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpContext } from "../../src/mcp/context.js";

const ctx: McpContext = {
  actorType: "chat",
  token: "sess-1",
  sessionId: "sess-1",
  userId: "user-1",
  tenantId: "tenant-1",
  role: "member",
};

const getTaskByIdMock = vi.fn();
const continueTaskMock = vi.fn();
const restartTaskMock = vi.fn();
const pauseTaskMock = vi.fn();
const resumeTaskMock = vi.fn();
const cancelTaskMock = vi.fn();

vi.mock("../../src/features/tasks/storage.js", () => ({
  getTaskById: (...a: any[]) => getTaskByIdMock(...a),
}));
vi.mock("../../src/features/tasks/control-service.js", () => ({
  cancelTask: (...a: any[]) => cancelTaskMock(...a),
  pauseTask: (...a: any[]) => pauseTaskMock(...a),
  resumeTask: (...a: any[]) => resumeTaskMock(...a),
  restartTask: (...a: any[]) => restartTaskMock(...a),
  continueTask: (...a: any[]) => continueTaskMock(...a),
  TaskControlError: class TaskControlError extends Error {},
}));

const { controlTask } = await import("../../src/mcp/tools/action-tools.js");

function flatten(res: any): string {
  return (res?.content ?? []).map((c: any) => c.text ?? "").join("\n");
}

describe("controlTask MCP tool — continue action", () => {
  beforeEach(() => {
    getTaskByIdMock.mockReset();
    continueTaskMock.mockReset();
    getTaskByIdMock.mockResolvedValue({ id: "t1", project_name: "demo", state: "completed" });
    continueTaskMock.mockResolvedValue({ ok: true, task: { project_name: "demo" }, state: "queued" });
  });

  it("triggers continueTask and converts scan_duration minutes to seconds", async () => {
    const res = await controlTask(
      { task_id: "t1", action: "continue", audit_focus: "  auth  ", scan_duration: 25 },
      ctx,
    );
    expect(continueTaskMock).toHaveBeenCalledWith("t1", { auditFocus: "auth", scanTimeout: 1500 });
    expect(flatten(res)).toContain("continue scanning");
  });

  it("passes undefined overrides when continue has no params", async () => {
    await controlTask({ task_id: "t1", action: "continue" }, ctx);
    expect(continueTaskMock).toHaveBeenCalledWith("t1", { auditFocus: undefined, scanTimeout: undefined });
  });

  it("returns not-found when task missing", async () => {
    getTaskByIdMock.mockResolvedValue(null);
    const res = await controlTask({ task_id: "x", action: "continue" }, ctx);
    expect(flatten(res)).toContain("Task not found");
    expect(continueTaskMock).not.toHaveBeenCalled();
  });
});
