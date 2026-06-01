import { Hono } from "hono";
import * as authStorage from "../auth/storage.js";
import { getVersionInfo } from "../../infra/version.js";
import { getInstallationId } from "./installation.js";
import { getLicenseStatus } from "./license-status.js";
import { loadConfig } from "../../infra/config.js";

export const systemRouter = new Hono();

// GET /api/system/status  (public, no auth required)
systemRouter.get("/status", async (c) => {
  const license = await getLicenseStatus();
  const hasAdmin = await authStorage.hasAnyAdmin();
  const isAuthenticated = !!c.get("user");
  const sessionUser = c.get("user");

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
        }
      : null,
  });
});
