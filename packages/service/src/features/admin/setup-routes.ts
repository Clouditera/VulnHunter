/**
 * Admin first-install setup endpoints (fish 2026-08-06 终稿, 单路径版).
 *
 * The /setup wizard only exists when NO admin exists yet (env provisioning
 * absent). Triple closure: has_admin → 403 / env-admin configured → 403 /
 * success → permanently closed (has_admin now true). Rate-limited per IP.
 *
 * Design: no licenseGuard here (the wizard must be reachable BEFORE license
 * activation); POST /setup/admin itself requires an ACTIVE license so the
 * wizard order (activate → create admin) is enforced server-side.
 */
import { Hono } from "hono";
import bcrypt from "bcrypt";
import { isStrongPassword, PASSWORD_RULE_MESSAGE } from "@vulnhunter/shared";
import * as authStorage from "../auth/storage.js";
import { getLicenseStatus } from "../system/license-status.js";

export const adminSetupRouter = new Hono();

const BCRYPT_COST = 10;

/** Env-provisioned system admin (deploy-managed; setup wizard must not create a second). */
function envAdminConfigured(): boolean {
  return !!(process.env.VULNHUNTER_ADMIN_EMAIL?.trim() && process.env.VULNHUNTER_ADMIN_PASSWORD);
}

// ── Rate limit: per-IP attempt window (in-memory; single-instance admin-api) ──
const SETUP_MAX_ATTEMPTS = 10;
const SETUP_WINDOW_MS = 15 * 60_000;
const ipAttempts = new Map<string, { count: number; windowStart: number }>();

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = ipAttempts.get(ip);
  if (!entry || now - entry.windowStart > SETUP_WINDOW_MS) {
    ipAttempts.set(ip, { count: 1, windowStart: now });
    return false;
  }
  entry.count += 1;
  return entry.count > SETUP_MAX_ATTEMPTS;
}

function clientIp(c: { req: { header: (n: string) => string | undefined } }): string {
  const fwd = c.req.header("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return c.req.header("x-real-ip") ?? "unknown";
}

// GET /api/admin/setup/status — public (pre-license, pre-admin). Drives the
// /setup wizard: has_admin tells the wizard whether it still exists;
// license_active decides which step is next; env_admin_configured explains
// why creation is disabled.
adminSetupRouter.get("/status", async (c) => {
  const license = await getLicenseStatus();
  return c.json({
    has_admin: await authStorage.hasAnyAdmin(),
    license_active: license.status === "active",
    env_admin_configured: envAdminConfigured(),
  });
});

// POST /api/admin/setup/admin — public but triple-closed + rate-limited.
adminSetupRouter.post("/admin", async (c) => {
  const ip = clientIp(c);
  if (checkRateLimit(ip)) {
    return c.json({ error: { code: "rate_limited", message: "Too many attempts from this IP" } }, 429);
  }

  // Triple closure 1: license must be active first (wizard order: activate → create).
  const license = await getLicenseStatus();
  if (license.status !== "active") {
    return c.json({ error: { code: "ERR_LICENSE_NOT_ACTIVATED" } }, 402);
  }

  // Triple closure 2: an admin already exists (created here or provisioned).
  if (await authStorage.hasAnyAdmin()) {
    return c.json({ error: { code: "ERR_ADMIN_SINGLETON", detail: "管理员已存在" } }, 403);
  }

  // Triple closure 3: deploy-provisioned admin configured — setup must not mint a second.
  if (envAdminConfigured()) {
    return c.json({ error: { code: "ERR_ADMIN_SINGLETON", detail: "管理员由部署配置管理，无需向导建号" } }, 403);
  }

  const body = await c.req.json<{ email?: string; password?: string }>();
  const email = (body.email ?? "").trim().toLowerCase();
  if (!email || !isStrongPassword(body.password ?? "")) {
    return c.json(
      { error: { code: "ERR_VALIDATION", field: "password", message: PASSWORD_RULE_MESSAGE } },
      400,
    );
  }

  // Create the singleton admin (same shape the old business /bootstrap used).
  const passwordHash = await bcrypt.hash(body.password!, BCRYPT_COST);
  await authStorage.createUser({ email, passwordHash, role: "admin" });
  // Success permanently closes the endpoint: hasAnyAdmin() is now true.
  return c.json({ ok: true });
});
