import { Readable } from "node:stream";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  order: [] as string[],
  listedPrefixes: [] as string[],
  sourceCleanupError: null as Error | null,
  warn: vi.fn(),
  task: {
    id: "11111111-2222-4333-8444-555566667777",
    tenant_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    created_by: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    state: "failed",
    run_count: 0,
    source_meta: { minio_key: "code-packages/upload-uuid.tar.gz" },
  } as Record<string, unknown>,
}));

vi.mock("../../src/middleware/auth.js", () => ({
  requireAuth: async (
    c: { set: (key: string, value: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set("user", {
      tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      role: "member",
    });
    await next();
  },
}));
vi.mock("../../src/middleware/license-guard.js", () => ({
  licenseGuard: async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock("../../src/features/tasks/storage.js", () => ({
  getTaskById: vi.fn(async () => m.task),
  deleteTask: vi.fn(async () => {
    m.order.push("db-delete");
    return true;
  }),
}));
vi.mock("../../src/features/tasks/source-cleanup.js", () => ({
  sourceArchiveCleanupKeys: vi.fn(() => {
    m.order.push("freeze-source-keys");
    return ["code-packages/upload-uuid.tar.gz"];
  }),
  cleanupUnreferencedSourceArchives: vi.fn(async () => {
    m.order.push("cleanup-source-keys");
    if (m.sourceCleanupError) throw m.sourceCleanupError;
  }),
}));
vi.mock("../../src/features/dynamic/provider.js", () => ({
  getDynamicProvider: () => ({
    releaseSandboxForTask: vi.fn(async () => {
      m.order.push("release-sandbox");
    }),
  }),
}));
vi.mock("../../src/features/workers/scan-worker.js", () => ({
  cleanupScanWorkDir: vi.fn(() => {
    m.order.push("cleanup-workspace");
  }),
}));
vi.mock("../../src/infra/config.js", () => ({
  loadConfig: () => ({
    dataDir: "/tmp/test-data",
    docker: { workerImage: "worker:test" },
    minio: { bucket: "artifact-store" },
  }),
}));
vi.mock("../../src/infra/minio/client.js", () => ({
  getMinio: () => ({
    listObjects: vi.fn((_bucket: string, prefix: string) => {
      m.order.push(`list:${prefix}`);
      m.listedPrefixes.push(prefix);
      return Readable.from([{ name: `${prefix}object` }], { objectMode: true });
    }),
    removeObjects: vi.fn(async (_bucket: string, keys: string[]) => {
      m.order.push(`remove:${keys[0]}`);
    }),
  }),
}));
vi.mock("../../src/infra/logger.js", () => ({
  logger: { warn: m.warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

// Imports unused by this route are mocked to keep this a deletion-wiring test.
vi.mock("../../src/features/events/event-archive.js", () => ({ loadTaskEvents: vi.fn() }));
vi.mock("../../src/features/events/event-store.js", () => ({ getEventTotal: vi.fn() }));
vi.mock("../../src/features/settings/storage.js", () => ({ listCredentials: vi.fn() }));
vi.mock("../../src/features/tasks/control-service.js", () => ({
  cancelTask: vi.fn(),
  continueTask: vi.fn(),
  pauseTask: vi.fn(),
  restartTask: vi.fn(),
  resumeTask: vi.fn(),
  TaskControlError: class TaskControlError extends Error {},
}));
vi.mock("../../src/features/auth/storage.js", () => ({ listUsersByIds: vi.fn() }));
vi.mock("../../src/features/auth/creator-summary.js", () => ({
  attachCreatorSummaries: vi.fn(),
  uniqueCreatorIds: vi.fn(),
}));
vi.mock("../../src/features/tasks/original-archive.js", () => ({
  originalArchiveDownloadSpec: vi.fn(),
}));
vi.mock("../../src/features/source-archives/policy.js", () => ({
  getSourceArchivePolicy: vi.fn(),
}));

const { tasksRouter } = await import("../../src/features/tasks/routes.js");
const { cleanupUnreferencedSourceArchives, sourceArchiveCleanupKeys } = await import(
  "../../src/features/tasks/source-cleanup.js"
);

function app() {
  const h = new Hono();
  h.route("/api/tasks", tasksRouter);
  return h;
}

beforeEach(() => {
  m.task.state = "failed";
  m.task.run_count = 0;
  m.order.length = 0;
  m.listedPrefixes.length = 0;
  m.sourceCleanupError = null;
  m.warn.mockClear();
  vi.mocked(cleanupUnreferencedSourceArchives).mockClear();
  vi.mocked(sourceArchiveCleanupKeys).mockClear();
});

describe("DELETE /api/tasks/:id source archive cleanup wiring", () => {
  it("freezes real keys before DB delete, then reference-gates exact cleanup", async () => {
    const res = await app().request(`/api/tasks/${m.task.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    expect(sourceArchiveCleanupKeys).toHaveBeenCalledWith(m.task);
    expect(cleanupUnreferencedSourceArchives).toHaveBeenCalledWith(
      ["code-packages/upload-uuid.tar.gz"],
      { taskId: m.task.id, reason: "task-delete" },
    );
    expect(m.order.indexOf("freeze-source-keys")).toBeLessThan(m.order.indexOf("db-delete"));
    expect(m.order.indexOf("db-delete")).toBeLessThan(m.order.indexOf("cleanup-source-keys"));
    expect(m.order.indexOf("release-sandbox")).toBeLessThan(m.order.indexOf("db-delete"));
  });

  it.each(["failed", "paused", "cancelled", "completed"])(
    "uses the same source cleanup chain for deletable %s tasks",
    async (state) => {
      m.task.state = state;
      const res = await app().request(`/api/tasks/${m.task.id}`, { method: "DELETE" });
      expect(res.status).toBe(200);
      expect(cleanupUnreferencedSourceArchives).toHaveBeenCalledTimes(1);
      expect(m.order).toContain("cleanup-workspace");
    },
  );

  it("never lists a naked task-id code-packages prefix", async () => {
    const res = await app().request(`/api/tasks/${m.task.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(m.listedPrefixes).toEqual([
      `scan-outputs/${m.task.id}/`,
      `source-files/${m.task.id}/`,
      `user-reports/${m.task.id}/`,
    ]);
    expect(m.listedPrefixes.some((prefix) => prefix.startsWith("code-packages/"))).toBe(false);
  });

  it("keeps DELETE 200 and continues artifacts/workspace when source cleanup fails", async () => {
    m.sourceCleanupError = new Error("minio unavailable");
    const res = await app().request(`/api/tasks/${m.task.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(m.order).toContain("cleanup-source-keys");
    expect(m.order).toContain(`list:scan-outputs/${m.task.id}/`);
    expect(m.order.at(-1)).toBe("cleanup-workspace");
    expect(m.warn).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: m.task.id }),
      expect.stringContaining("source archive cleanup failure"),
    );
  });
});
