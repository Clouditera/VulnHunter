import { Hono } from "hono";
import * as licenseService from "./service.js";
import * as authStorage from "../auth/storage.js";
import { getVersionInfo } from "../../infra/version.js";

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
      licensed_version: licenseState.licensedVersion,
      invalid_reason: licenseState.invalidReason,
    },
    version: getVersionInfo(),
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
  const body = await c.req.json<{ cert: string }>().catch(() => ({ cert: "" }));
  if (!body.cert) {
    return c.json({ error: { code: "ERR_BAD_REQUEST", detail: "cert required" } }, 400);
  }

  const result = await licenseService.activate(body.cert);
  if (!result.ok) {
    const code = result.error === "license_verifier_unconfigured"
      ? "ERR_LICENSE_VERIFIER_UNCONFIGURED"
      : "ERR_LICENSE_INVALID";
    return c.json(
      { error: { code, detail: result.error } },
      code === "ERR_LICENSE_VERIFIER_UNCONFIGURED" ? 500 : 402,
    );
  }

  return c.json({ ok: true });
});
