import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../../src/middleware/error-handler.js";

/**
 * fish 2026-08-10: unique admin — community admin-users route must refuse
 * suspend/delete of any role=admin (including is_system=false).
 */

const users = new Map<string, any>();
const updateUser = vi.fn(async () => undefined);
const deleteUser = vi.fn(async () => undefined);
const deleteAllSessionsForUser = vi.fn(async () => undefined);
const countAdmins = vi.fn(async () => 2);
const getUserById = vi.fn(async (id: string) => users.get(id) ?? null);
const listUsers = vi.fn(async () => [...users.values()]);

vi.mock("../../src/features/auth/storage.js", () => ({
  getUserById,
  listUsers,
  updateUser,
  deleteUser,
  deleteAllSessionsForUser,
  countAdmins,
}));
vi.mock("../../src/features/tasks/storage.js", () => ({
  countTasksForUser: vi.fn(async () => 0),
}));
vi.mock("../../src/features/auth/agreements.js", () => ({
  listAcceptancesForUsers: vi.fn(async () => new Map()),
}));
vi.mock("../../src/infra/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../src/infra/config.js", () => ({
  loadConfig: vi.fn(() => ({ minio: { bucket: "b" } })),
}));
vi.mock("../../src/infra/minio/cleanup.js", () => ({
  removeKeysBestEffort: vi.fn(),
}));
vi.mock("../../src/infra/db/client.js", () => ({
  getDb: () => {
    const fn = async () => [] as { key: string }[];
    return fn;
  },
}));
vi.mock("bcrypt", () => ({
  default: { hash: vi.fn(async () => "hash") },
}));

// Capture actor per request via middleware
let actorId = "admin-a";
vi.mock("../../src/middleware/auth.js", () => ({
  requireAdmin: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set("user", { userId: actorId, role: "admin", tenantId: "t1" });
    await next();
  },
}));
vi.mock("../../src/middleware/license-guard.js", () => ({
  licenseGuard: async (_c: unknown, next: () => Promise<void>) => next(),
}));

const { adminUsersRouter } = await import("../../src/features/auth/admin-users.js");

function seed() {
  users.clear();
  for (const u of [
    { id: "admin-a", email: "a@x.com", role: "admin", is_system: false },
    { id: "admin-b", email: "b@x.com", role: "admin", is_system: false },
    { id: "mem-1", email: "m@x.com", role: "member", is_system: false },
  ]) {
    users.set(u.id, {
      ...u,
      status: "active",
      tenant_id: "t1",
      display_name: "X",
      source: "admin",
      must_change_password: false,
      task_limit: 0,
      sandbox_max_running: 0,
      sandbox_max_cpu_cores: 0,
      sandbox_max_memory_gb: 0,
      last_login_at: null,
      created_at: new Date(),
      admin_remark: null,
    });
  }
}

function app() {
  const h = new Hono();
  h.onError(errorHandler);
  h.route("/", adminUsersRouter);
  return h;
}

describe("admin-users: no suspend/delete of admin", () => {
  beforeEach(() => {
    seed();
    actorId = "admin-a";
    updateUser.mockClear();
    deleteUser.mockClear();
    deleteAllSessionsForUser.mockClear();
  });

  it("self-suspend (is_system=false admin) → ERR_ADMIN_SINGLETON", async () => {
    const res = await app().request("/admin-a", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "suspended" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("ERR_ADMIN_SINGLETON");
    expect(updateUser).not.toHaveBeenCalled();
  });

  it("suspend other admin (two is_system=false) → ERR_ADMIN_SINGLETON", async () => {
    const res = await app().request("/admin-b", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "suspended" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("ERR_ADMIN_SINGLETON");
    expect(updateUser).not.toHaveBeenCalled();
  });

  it("suspend member → ok", async () => {
    const res = await app().request("/mem-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "suspended" }),
    });
    expect(res.status).toBe(200);
    expect(updateUser).toHaveBeenCalled();
  });

  it("delete admin → ERR_ADMIN_SINGLETON", async () => {
    const res = await app().request("/admin-b", { method: "DELETE" });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("ERR_ADMIN_SINGLETON");
    expect(deleteUser).not.toHaveBeenCalled();
  });
});
