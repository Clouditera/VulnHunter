import { Hono } from "hono";
import * as authStorage from "../auth/storage.js";
import { getVersionInfo } from "../../infra/version.js";
import { getInstallationId } from "./installation.js";
import { getLicenseStatus } from "./license-status.js";
import { loadConfig } from "../../infra/config.js";
import { countTasksForUser } from "../tasks/storage.js";
import { queryContextFromUser } from "../../infra/query-context.js";
import { getHomePublicStats } from "../home/stats.js";

export const systemRouter = new Hono();

// GET /api/system/home-stats  (SaaS-only marketing aggregates — no PII)
// HALL-6: 私有化部署（enterprise/community）不暴露营销统计，纵深防御返回 404。
systemRouter.get("/home-stats", async (c) => {
  if (loadConfig().edition !== "saas") return c.json({ error: "not_found" }, 404);
  const stats = await getHomePublicStats();
  return c.json({ stats });
});

async function statusHandler(c: any) {
  const license = await getLicenseStatus();
  const hasAdmin = await authStorage.hasAnyAdmin();
  const isAuthenticated = !!c.get("user");
  const sessionUser = c.get("user");
  const taskCount = sessionUser ? await countTasksForUser(queryContextFromUser(sessionUser)) : undefined;
  const dbUser = sessionUser ? await authStorage.getUserById(sessionUser.userId) : null;

  return c.json({
    edition: loadConfig().edition,
    license,
    version: getVersionInfo(),
    has_admin: hasAdmin,
    is_authenticated: isAuthenticated,
    installation_id: getInstallationId(),
    // fish 2026-08-06: business-web guards redirect to the admin console
    // /setup wizard — the port comes from the status API, zero hardcode.
    admin_console_port: Number(process.env.ADMIN_PORT ?? 23001),
    user: sessionUser
      ? {
          id: sessionUser.userId,
          email: sessionUser.email,
          role: sessionUser.role,
          displayName: sessionUser.displayName,
          task_limit: dbUser?.task_limit ?? 0,
          task_count: taskCount ?? 0,
          onboarding_dismissed: dbUser?.onboarding_dismissed_at != null,
        }
      : null,
  });
}

// GET /api/system/status  (public, no auth required)
systemRouter.get("/status", statusHandler);

/** admin-api system subset: status only (activate mounted by enterprise or separately). */
export const adminSystemRouter = new Hono();
adminSystemRouter.get("/status", statusHandler);
