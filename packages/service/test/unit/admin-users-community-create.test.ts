import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../../src/middleware/error-handler.js";

/**
 * Community user creation (option a, split regression 2026-08-25): the first
 * real community pack exposed that POST /api/admin/users only existed in the
 * enterprise module — community deployments had no way to create any business
 * user. Core now carries a basic-fields POST.
 */

const users = new Map<string, any>();
const findUserByEmail = vi.fn(async (email: string) =>
  [...users.values()].find((u) => u.email === email) ?? null,
);
const createUser = vi.fn(async (p: any) => {
  const u = { id: `u-${users.size + 1}`, ...p, status: "active", role: "member" };
  users.set(u.id, u);
  return u;
});

vi.mock("../../src/features/auth/storage.js", () => ({
  findUserByEmail,
  createUser,
  listUsers: vi.fn(async () => [...users.values()]),
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
vi.mock("../../src/middleware/auth.js", () => ({
  requireAdmin: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set("user", { userId: "admin-a", role: "admin", tenantId: "t1" });
    await next();
  },
}));
vi.mock("../../src/middleware/license-guard.js", () => ({
  licenseGuard: async (_c: unknown, next: () => Promise<void>) => next(),
}));

const { adminUsersRouter } = await import("../../src/features/auth/admin-users.js");

function app() {
  const h = new Hono();
  h.onError(errorHandler);
  h.route("/", adminUsersRouter);
  return h;
}

beforeEach(() => users.clear());

describe("POST /api/admin/users (community core)", () => {
  it("creates a member user with basic fields", async () => {
    const res = await app().request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "dev@x.com", password: "longenough1", display_name: "Dev" }),
    });
    expect(res.status).toBe(201);
    const j: any = await res.json();
    expect(j.email).toBe("dev@x.com");
    expect(createUser).toHaveBeenCalledWith(
      expect.objectContaining({ email: "dev@x.com", role: "member", mustChangePassword: false }),
    );
  });

  it("rejects short password / missing email", async () => {
    const res = await app().request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "a@b.com", password: "short" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects duplicate email", async () => {
    await app().request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "dup@x.com", password: "longenough1" }),
    });
    const res2 = await app().request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "dup@x.com", password: "longenough1" }),
    });
    expect(res2.status).toBe(409);
  });

  it("never grants admin role (singleton admin stays deploy-provisioned)", async () => {
    await app().request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "try@x.com", password: "longenough1", role: "admin" } as any),
    });
    expect(createUser).toHaveBeenCalledWith(expect.objectContaining({ role: "member" }));
  });
});
