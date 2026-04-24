import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { requireAuth, requireAdmin } from "../../middleware/auth.js";
import { licenseGuard } from "../../middleware/license-guard.js";
import * as authService from "./service.js";
import * as authStorage from "./storage.js";


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
authRouter.post("/change-password", requireAuth, async (c) => {
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
authRouter.post("/force-change-password", requireAuth, async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ new_password: string }>();

  if (!body.new_password || body.new_password.length < 8) {
    return c.json({ error: { code: "ERR_VALIDATION", message: "Password must be at least 8 characters" } }, 400);
  }

  await authService.forceChangePassword(user.userId, body.new_password);
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

// ─── User Management (admin only) ───

export const userRouter = new Hono();
userRouter.use("*", licenseGuard);
userRouter.use("*", requireAdmin);

userRouter.get("/", async (c) => {
  const users = await authStorage.listUsers();
  return c.json({
    users: users.map((u) => ({
      id: u.id,
      email: u.email,
      display_name: u.display_name,
      role: u.role,
      status: u.status,
      must_change_password: u.must_change_password,
      last_login_at: u.last_login_at,
      created_at: u.created_at,
    })),
  });
});

userRouter.post("/", async (c) => {
  const body = await c.req.json<{ email: string; password: string; display_name?: string; role?: "admin" | "member" }>();
  if (!body.email || !body.password || body.password.length < 8) {
    return c.json({ error: { code: "ERR_VALIDATION", message: "Email and password (min 8 chars) required" } }, 400);
  }
  const existing = await authStorage.findUserByEmail(body.email);
  if (existing) return c.json({ error: { code: "ERR_CONFLICT", message: "Email already exists" } }, 409);

  const user = await authService.createUserAccount({
    email: body.email,
    password: body.password,
    displayName: body.display_name,
    role: body.role ?? "member",
  });
  return c.json({ user: { id: user.id, email: user.email, display_name: user.display_name, role: user.role } }, 201);
});

userRouter.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ display_name?: string; role?: string; status?: string; reset_password?: string }>();
  const user = await authStorage.getUserById(id);
  if (!user) return c.json({ error: { code: "ERR_NOT_FOUND" } }, 404);

  if (body.role && body.role !== "admin" && user.role === "admin") {
    const adminCount = await authStorage.countAdmins();
    if (adminCount <= 1) return c.json({ error: { code: "ERR_LAST_ADMIN", message: "Cannot demote the last admin" } }, 400);
  }

  const fields: Parameters<typeof authStorage.updateUser>[1] = {
    displayName: body.display_name,
    role: body.role,
    status: body.status,
  };
  if (body.reset_password) {
    const { hashSync } = await import("bcrypt");
    fields.passwordHash = hashSync(body.reset_password, 10);
    fields.mustChangePassword = true;
  }
  await authStorage.updateUser(id, fields);
  return c.json({ ok: true });
});

userRouter.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const user = await authStorage.getUserById(id);
  if (!user) return c.json({ error: { code: "ERR_NOT_FOUND" } }, 404);

  if (user.role === "admin") {
    const adminCount = await authStorage.countAdmins();
    if (adminCount <= 1) return c.json({ error: { code: "ERR_LAST_ADMIN", message: "Cannot delete the last admin" } }, 400);
  }
  const currentUser = c.get("user");
  if (currentUser.userId === id) return c.json({ error: { code: "ERR_SELF_DELETE", message: "Cannot delete yourself" } }, 400);

  await authStorage.deleteUser(id);
  return c.json({ ok: true });
});
