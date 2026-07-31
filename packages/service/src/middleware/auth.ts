import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { resolveApiToken } from "../features/auth/api-token-storage.js";
import { resolveSession } from "../features/auth/service.js";
import { sessionCookieName } from "../features/auth/session-cookie.js";
import type { SessionUser } from "../features/auth/types.js";

/** Inject user into context if session cookie is valid. Does NOT reject — use requireAuth for that. */
export const injectUser: MiddlewareHandler = async (c, next) => {
  const sessionId = getCookie(c, sessionCookieName());
  if (sessionId) {
    const user = await resolveSession(sessionId);
    if (user) {
      c.set("user", user as SessionUser);
    }
  }

  // Cookie takes priority; only fall back to a "vht_" Bearer token when the
  // request carried no valid session. The browser cookie path above is left
  // byte-for-byte unchanged. The "vht_" prefix keeps these tokens distinct
  // from the task-id Bearer used by internal/task-bearer-auth.ts.
  if (!c.get("user")) {
    const m = /^Bearer\s+(vht_.+)$/i.exec(c.req.header("authorization")?.trim() ?? "");
    if (m) {
      const user = await resolveApiToken(m[1]);
      if (user) c.set("user", user);
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
