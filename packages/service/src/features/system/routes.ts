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

// GET /api/system/home-stats  (public marketing aggregates — no PII)
systemRouter.get("/home-stats", async (c) => {
  const stats = await getHomePublicStats();
  return c.json({ stats });
});

// GET /api/system/status  (public, no auth required)
systemRouter.get("/status", async (c) => {
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
    user: sessionUser
      ? {
          id: sessionUser.userId,
          email: sessionUser.email,
          role: sessionUser.role,
          displayName: sessionUser.displayName,
          task_limit: dbUser?.task_limit ?? 0,
          task_count: taskCount ?? 0,
        }
      : null,
  });
});
