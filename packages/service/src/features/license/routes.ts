import { Hono } from "hono";
import * as licenseService from "./service.js";
import * as authStorage from "../auth/storage.js";

export const systemRouter = new Hono();

// GET /api/system/status  (public, no auth required)
systemRouter.get("/status", async (c) => {
  const licenseState = await licenseService.getCurrentState();
  const hasAdmin = await authStorage.hasAnyAdmin();
  // Session check via cookie (if set, auth middleware already ran; here we check presence)
  const isAuthenticated = !!c.get("user");

  const sessionUser = c.get("user");

  return c.json({
    license: {
      status: licenseState.status,
      expires_at: licenseState.expiresAt?.toISOString(),
      days_remaining: licenseState.daysRemaining,
      machine_code: licenseState.machineCode,
    },
    has_admin: hasAdmin,
    is_authenticated: isAuthenticated,
    installation_id: licenseService.getInstallationId(),
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

// POST /api/system/activate  (public)
systemRouter.post("/activate", async (c) => {
  const body = await c.req.json<{ cert: string }>();
  if (!body.cert) {
    return c.json({ error: { code: "ERR_INTERNAL", detail: "cert required" } }, 400);
  }

  const result = await licenseService.activate(body.cert);
  if (!result.ok) {
    return c.json(
      { error: { code: "ERR_LICENSE_INVALID", detail: result.error } },
      402,
    );
  }

  return c.json({ ok: true });
});
