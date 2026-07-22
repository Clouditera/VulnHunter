import { Hono } from "hono";
import { requireAdmin } from "../../middleware/auth.js";
import { licenseGuard } from "../../middleware/license-guard.js";
import * as authStorage from "./storage.js";
import { countTasksForUser } from "../tasks/storage.js";

export const adminUsersRouter = new Hono();
adminUsersRouter.use("*", licenseGuard);
adminUsersRouter.use("*", requireAdmin);

function serializeAdminUser(u: authStorage.DbUser, taskCount: number) {
  return {
    id: u.id,
    email: u.email,
    display_name: u.display_name,
    role: u.role,
    status: u.status,
    source: u.source ?? "admin",
    must_change_password: u.must_change_password,
    task_limit: u.task_limit,
    sandbox_max_running: u.sandbox_max_running,
    sandbox_max_cpu_cores: u.sandbox_max_cpu_cores,
    sandbox_max_memory_gb: u.sandbox_max_memory_gb,
    task_count: taskCount,
    last_login_at: u.last_login_at,
    created_at: u.created_at,
    admin_remark: u.admin_remark ?? null,
  };
}

// GET /api/admin/users
adminUsersRouter.get("/", async (c) => {
  const users = await authStorage.listUsers();
  const counts = await Promise.all(
    users.map(async (u) =>
      countTasksForUser({ tenantId: u.tenant_id, userId: u.id, role: u.role as "admin" | "member" }),
    ),
  );
  return c.json({
    users: users.map((u, i) => serializeAdminUser(u, counts[i] ?? 0)),
  });
});

// PATCH /api/admin/users/:id — status only (contract A5); other fields stay on /api/users
adminUsersRouter.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ status?: "active" | "suspended" }>();
  const user = await authStorage.getUserById(id);
  if (!user) return c.json({ error: { code: "ERR_NOT_FOUND" } }, 404);

  const me = c.get("user");
  if (body.status === "suspended") {
    if (me.userId === id) {
      return c.json({ error: { code: "ERR_SELF_SUSPEND", message: "Cannot disable yourself" } }, 400);
    }
    if (user.role === "admin") {
      const adminCount = await authStorage.countAdmins();
      if (adminCount <= 1) {
        return c.json({ error: { code: "ERR_LAST_ADMIN", message: "Cannot disable the last admin" } }, 400);
      }
    }
  }

  if (body.status === "active" || body.status === "suspended") {
    await authStorage.updateUser(id, { status: body.status });
  }
  return c.json({ ok: true });
});

// DELETE /api/admin/users/:id
adminUsersRouter.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const user = await authStorage.getUserById(id);
  if (!user) return c.json({ error: { code: "ERR_NOT_FOUND" } }, 404);

  const me = c.get("user");
  if (me.userId === id) {
    return c.json({ error: { code: "ERR_SELF_DELETE", message: "Cannot delete yourself" } }, 400);
  }
  if (user.role === "admin") {
    const adminCount = await authStorage.countAdmins();
    if (adminCount <= 1) {
      return c.json({ error: { code: "ERR_LAST_ADMIN", message: "Cannot delete the last admin" } }, 400);
    }
  }

  await authStorage.deleteUser(id);
  return c.json({ ok: true });
});
