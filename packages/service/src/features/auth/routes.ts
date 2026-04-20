import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import * as authService from "./service.js";

const SESSION_COOKIE = "vh_session";
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // 30 days in seconds

export const authRouter = new Hono();

// POST /api/auth/login
authRouter.post("/login", async (c) => {
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
authRouter.post("/bootstrap", async (c) => {
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
