import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { resolveSession } from "../features/auth/service.js";
import type { SessionUser } from "../features/auth/types.js";

const SESSION_COOKIE = "va_session";

/** Inject user into context if session cookie is valid. Does NOT reject — use requireAuth for that. */
export const injectUser: MiddlewareHandler = async (c, next) => {
  const sessionId = getCookie(c, SESSION_COOKIE);
  if (sessionId) {
    const user = await resolveSession(sessionId);
    if (user) {
      c.set("user", user as SessionUser);
    }
  }
  await next();
};

/** Require authenticated session — returns 401 if not */
export const requireAuth: MiddlewareHandler = async (c, next) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ error: { code: "ERR_AUTH_REQUIRED" } }, 401);
  }
  return next();
};

/** Require admin role */
export const requireAdmin: MiddlewareHandler = async (c, next) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ error: { code: "ERR_AUTH_REQUIRED" } }, 401);
  }
  if (user.role !== "admin") {
    return c.json({ error: { code: "ERR_ADMIN_REQUIRED" } }, 403);
  }
  return next();
};

/** Block admin accounts from business APIs (admin console only). */
export const forbidAdmin: MiddlewareHandler = async (c, next) => {
  const user = c.get("user");
  if (user?.role === "admin") {
    return c.json({ error: { code: "ERR_ADMIN_BUSINESS_FORBIDDEN" } }, 403);
  }
  return next();
};
