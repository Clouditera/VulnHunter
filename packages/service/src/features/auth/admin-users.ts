import { Hono } from "hono";
import { requireAdmin } from "../../middleware/auth.js";
import { licenseGuard } from "../../middleware/license-guard.js";
import { AppError } from "../../infra/app-error.js";
import { logger } from "../../infra/logger.js";
import * as authStorage from "./storage.js";
import { countTasksForUser } from "../tasks/storage.js";
import { listAcceptancesForUsers } from "./agreements.js";

export const adminUsersRouter = new Hono();
adminUsersRouter.use("*", licenseGuard);
adminUsersRouter.use("*", requireAdmin);

function clientIp(c: { req: { header: (n: string) => string | undefined } }): string | undefined {
  return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("x-real-ip") || undefined;
}

function serializeAdminUser(
  u: authStorage.DbUser,
  taskCount: number,
  agreements: Array<{ agreement_id: string; agreement_title: string; agreement_version: string; accepted_at: Date | string }> = [],
) {
  return {
    id: u.id,
    email: u.email,
    display_name: u.display_name,
    role: u.role,
    status: u.status,
    source: u.source ?? "admin",
    is_system: Boolean(u.is_system),
    must_change_password: u.must_change_password,
    task_limit: u.task_limit,
    sandbox_max_running: u.sandbox_max_running,
    sandbox_max_cpu_cores: u.sandbox_max_cpu_cores,
    sandbox_max_memory_gb: u.sandbox_max_memory_gb,
    task_count: taskCount,
    last_login_at: u.last_login_at,
    created_at: u.created_at,
    admin_remark: u.admin_remark ?? null,
    agreements: agreements.map((a) => ({
      id: a.agreement_id,
      title: a.agreement_title,
      version: a.agreement_version,
      accepted_at: a.accepted_at,
    })),
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
  const acceptMap = await listAcceptancesForUsers(users.map((u) => u.id));
  return c.json({
    users: users.map((u, i) => serializeAdminUser(u, counts[i] ?? 0, acceptMap.get(u.id) ?? [])),
  });
});

// PATCH /api/admin/users/:id — status only (contract A5); other fields stay on /api/users
adminUsersRouter.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{
    status?: "active" | "suspended";
    role?: string;
    reset_password?: string;
    display_name?: string;
  }>();
  const user = await authStorage.getUserById(id);
  if (!user) throw new AppError("ERR_NOT_FOUND");

  const me = c.get("user");
  const ip = clientIp(c);

  // Community admin-users is status-only. Reject password/role mutations with
  // explicit 400 so clients never see silent "ok" that did not apply (QA).
  if (body.reset_password !== undefined) {
    logger.warn({ actor: me.userId, target: id, action: "reset_password", result: "denied", ip });
    return c.json(
      {
        error: {
          code: user.is_system ? "ERR_PROTECTED_ACCOUNT" : "ERR_PROTECTED_ACCOUNT",
          message: user.is_system
            ? "系统管理员账号受保护，请通过部署配置管理"
            : "请使用完整用户管理接口重置密码",
        },
      },
      400,
    );
  }
  if (body.role !== undefined) {
    logger.warn({ actor: me.userId, target: id, action: "role", result: "denied_singleton", ip });
    return c.json(
      { error: { code: "ERR_ADMIN_SINGLETON", message: "管理员由部署配置唯一供给" } },
      400,
    );
  }

  if (user.is_system) {
    logger.warn({
      actor: me.userId,
      target: id,
      action: "status",
      result: "denied_protected",
      ip,
    });
    return c.json(
      {
        error: {
          code: "ERR_PROTECTED_ACCOUNT",
          message: "系统管理员账号受保护，请通过部署配置管理",
        },
      },
      400,
    );
  }

  if (body.status === "suspended") {
    if (me.userId === id) {
      throw new AppError("ERR_SELF_SUSPEND");
    }
    if (user.role === "admin") {
      const adminCount = await authStorage.countAdmins();
      if (adminCount <= 1) {
        throw new AppError("ERR_LAST_ADMIN");
      }
    }
  }

  if (body.status === "active" || body.status === "suspended") {
    try {
      await authStorage.updateUser(id, { status: body.status });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "ERR_PROTECTED_ACCOUNT") {
        throw new AppError("ERR_PROTECTED_ACCOUNT");
      }
      throw err;
    }
    if (body.status === "suspended") {
      await authStorage.deleteAllSessionsForUser(id);
      logger.warn({ actor: me.userId, target: id, action: "suspend", result: "ok", ip });
    }
  }
  return c.json({ ok: true });
});

// DELETE /api/admin/users/:id
adminUsersRouter.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const user = await authStorage.getUserById(id);
  if (!user) throw new AppError("ERR_NOT_FOUND");

  const me = c.get("user");
  const ip = clientIp(c);

  if (user.is_system) {
    logger.warn({ actor: me.userId, target: id, action: "delete", result: "denied_protected", ip });
    return c.json(
      {
        error: {
          code: "ERR_PROTECTED_ACCOUNT",
          message: "系统管理员账号受保护，请通过部署配置管理",
        },
      },
      400,
    );
  }

  if (me.userId === id) {
    throw new AppError("ERR_SELF_DELETE");
  }
  if (user.role === "admin") {
    const adminCount = await authStorage.countAdmins();
    if (adminCount <= 1) {
      throw new AppError("ERR_LAST_ADMIN");
    }
  }

  try {
    await authStorage.deleteUser(id);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ERR_PROTECTED_ACCOUNT") {
      throw new AppError("ERR_PROTECTED_ACCOUNT");
    }
    throw err;
  }
  logger.warn({ actor: me.userId, target: id, action: "delete", result: "ok", ip });
  return c.json({ ok: true });
});
