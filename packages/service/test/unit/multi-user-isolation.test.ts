import { beforeEach, describe, expect, it, vi } from "vitest";

const state = {
  calls: [] as any[],
  task: null as any,
};

vi.mock("../../src/features/tasks/storage.js", () => ({
  getTaskById: vi.fn(async (...args: any[]) => {
    state.calls.push(args);
    return state.task;
  }),
}));

const { queryContextFromUser, shouldFilterByUser } = await import("../../src/infra/query-context.js");
const { getAccessibleTask } = await import("../../src/features/tasks/access.js");

describe("multi-user query isolation", () => {
  beforeEach(() => {
    state.calls = [];
    state.task = null;
  });

  it("filters member queries by user and tenant", () => {
    const ctx = queryContextFromUser({ userId: "member-1", tenantId: "tenant-1", role: "member" });
    expect(ctx).toEqual({ userId: "member-1", tenantId: "tenant-1", role: "member" });
    expect(shouldFilterByUser(ctx)).toBe(true);
  });

  it("does not filter admin queries by user", () => {
    const ctx = queryContextFromUser({ userId: "admin-1", tenantId: "tenant-1", role: "admin" });
    expect(shouldFilterByUser(ctx)).toBe(false);
  });

  it("loads accessible task through ctx-aware storage", async () => {
    const ctx = { userId: "member-1", tenantId: "tenant-1", role: "member" as const };
    state.task = { id: "task-1", created_by: "member-1" };

    const task = await getAccessibleTask(ctx, "task-1");

    expect(task).toEqual(state.task);
    expect(state.calls).toEqual([[ctx, "task-1"]]);
  });
});
