import { beforeEach, describe, expect, it, vi } from "vitest";

interface UserRow {
  id: string;
  email: string;
  role: string;
  status: string;
  is_system: boolean;
  password_hash: string;
  display_name: string;
  tenant_id: string;
  source: string;
  admin_remark: null;
  must_change_password: boolean;
  task_limit: number;
  sandbox_max_running: number;
  sandbox_max_cpu_cores: number;
  sandbox_max_memory_gb: number;
  last_login_at: null;
  onboarding_dismissed_at: null;
  created_at: Date;
  updated_at: Date;
}

const users = new Map<string, UserRow>();

vi.mock("../../src/infra/db/client.js", () => ({
  getDb: () => {
    const fn = async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join("?");
      if (sql.includes("SELECT * FROM users WHERE id =")) {
        const [id] = values as [string];
        const u = users.get(id);
        return u ? [u] : [];
      }
      if (sql.includes("UPDATE users SET")) {
        // update applied after guard in updateUser
        return [];
      }
      if (sql.includes("DELETE FROM users") || sql.includes("BEGIN") || sql.includes("UPDATE tasks")) {
        return [];
      }
      return [];
    };
    (fn as any).begin = async (cb: (tx: typeof fn) => Promise<void>) => cb(fn);
    return fn;
  },
}));

const { updateUser, deleteUser } = await import("../../src/features/auth/storage.js");

function seed(partial: Partial<UserRow> & { id: string; is_system: boolean }) {
  users.set(partial.id, {
    id: partial.id,
    email: partial.email ?? "a@b.c",
    role: partial.role ?? "admin",
    status: partial.status ?? "active",
    is_system: partial.is_system,
    password_hash: "x",
    display_name: "A",
    tenant_id: "00000000-0000-0000-0000-000000000001",
    source: "admin",
    admin_remark: null,
    must_change_password: false,
    task_limit: 0,
    sandbox_max_running: 0,
    sandbox_max_cpu_cores: 0,
    sandbox_max_memory_gb: 0,
    last_login_at: null,
    onboarding_dismissed_at: null,
    created_at: new Date(),
    updated_at: new Date(),
  });
}

describe("system admin storage guards", () => {
  beforeEach(() => {
    users.clear();
    seed({ id: "sys", is_system: true, role: "admin" });
    seed({ id: "mem", is_system: false, role: "member", email: "m@b.c" });
  });

  it("rejects suspend on is_system", async () => {
    await expect(updateUser("sys", { status: "suspended" })).rejects.toMatchObject({
      code: "ERR_PROTECTED_ACCOUNT",
    });
  });

  it("rejects demote on is_system", async () => {
    await expect(updateUser("sys", { role: "member" })).rejects.toMatchObject({
      code: "ERR_PROTECTED_ACCOUNT",
    });
  });

  it("rejects password reset from UI path on is_system", async () => {
    await expect(updateUser("sys", { passwordHash: "new" })).rejects.toMatchObject({
      code: "ERR_PROTECTED_ACCOUNT",
    });
  });

  it("allows provision path password + isSystem on is_system", async () => {
    await expect(
      updateUser("sys", { passwordHash: "new", isSystem: true, status: "active", role: "admin" }),
    ).resolves.toBeUndefined();
  });

  it("rejects delete on is_system", async () => {
    await expect(deleteUser("sys")).rejects.toMatchObject({ code: "ERR_PROTECTED_ACCOUNT" });
  });

  it("allows suspend on normal member", async () => {
    await expect(updateUser("mem", { status: "suspended" })).resolves.toBeUndefined();
  });
});
