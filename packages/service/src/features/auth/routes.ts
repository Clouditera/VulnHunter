import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { requireAuth } from "../../middleware/auth.js";
import { licenseGuard } from "../../middleware/license-guard.js";
import * as authService from "./service.js";
import * as authStorage from "./storage.js";


const SESSION_COOKIE = "va_session";
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // 30 days in seconds

export const authRouter = new Hono();

// POST /api/auth/login
authRouter.post("/login", licenseGuard, async (c) => {
  const body = await c.req.json<{ email: string; password: string }>();
  const ip = c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip");
  const userAgent = c.req.header("user-agent");

  const result = await authService.login({
    email: body.email,
    password: body.password,
    ip,
    userAgent,
  });

  if ("error" in result) {
    const code = result.error === "locked" ? "ERR_AUTH_LOCKED" : "ERR_AUTH_INVALID_CREDENTIALS";
    return c.json({ error: { code } }, result.error === "locked" ? 429 : 401);
  }

  setCookie(c, SESSION_COOKIE, result.sessionId, {
    httpOnly: true,
    sameSite: "Strict",
    path: "/",
    maxAge: COOKIE_MAX_AGE,
  });

  return c.json({
    ok: true,
    user: {
      id: result.user.id,
      email: result.user.email,
      displayName: result.user.display_name,
      role: result.user.role,
      mustChangePassword: result.user.must_change_password,
    },
  });
});

// POST /api/auth/change-password (personal, requires old password)
authRouter.post("/change-password", licenseGuard, requireAuth, async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ old_password: string; new_password: string }>();

  if (!body.old_password || !body.new_password || body.new_password.length < 8) {
    return c.json({ error: { code: "ERR_VALIDATION", message: "New password must be at least 8 characters" } }, 400);
  }

  const result = await authService.changePassword(user.userId, body.old_password, body.new_password);
  if ("error" in result) {
    return c.json({ error: { code: "ERR_AUTH_INVALID_CREDENTIALS", message: result.error } }, 401);
  }

  return c.json({ ok: true });
});

// POST /api/auth/force-change-password (first-login flow)
authRouter.post("/force-change-password", licenseGuard, requireAuth, async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ new_password: string }>();

  if (!body.new_password || body.new_password.length < 8) {
    return c.json({ error: { code: "ERR_VALIDATION", message: "Password must be at least 8 characters" } }, 400);
  }

  await authService.forceChangePassword(user.userId, body.new_password);
  return c.json({ ok: true });
});

// PATCH /api/auth/me — self-update display_name
authRouter.patch("/me", licenseGuard, requireAuth, async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ display_name?: string }>();
  if (body.display_name !== undefined) {
    await authStorage.updateUser(user.userId, { displayName: body.display_name });
  }
  return c.json({ ok: true });
});

// POST /api/auth/logout
authRouter.post("/logout", async (c) => {
  const sessionId = getCookie(c, SESSION_COOKIE);
  if (sessionId) {
    await authService.logout(sessionId);
  }
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

// POST /api/system/bootstrap
authRouter.post("/bootstrap", licenseGuard, async (c) => {
  const body = await c.req.json<{ email: string; password: string }>();

  if (!body.email || !body.password || body.password.length < 8) {
    return c.json(
      { error: { code: "ERR_INTERNAL", detail: "email and password (min 8 chars) required" } },
      400,
    );
  }

  const result = await authService.bootstrap(body);
  if (!result.success) {
    return c.json(
      { error: { code: "ERR_INTERNAL", detail: result.error } },
      409,
    );
  }

  return c.json({ ok: true });
});
