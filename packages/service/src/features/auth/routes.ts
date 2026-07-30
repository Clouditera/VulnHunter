import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { isStrongPassword, PASSWORD_RULE_MESSAGE } from "@vulnhunter/shared";
import { requireAuth } from "../../middleware/auth.js";
import { licenseGuard } from "../../middleware/license-guard.js";
import * as authService from "./service.js";
import * as authStorage from "./storage.js";
import * as emailCodes from "./email-codes.js";
import { isSmtpConfigured, sendVerificationEmail } from "../settings/smtp.js";
import {
  listRegisterAgreements,
  getAgreementHtml,
  recordRegisterAcceptances,
} from "./agreements.js";
import { sessionCookieName, COOKIE_MAX_AGE } from "./session-cookie.js";

// IP rate limit (in-memory, single instance)
const ipSendCounts = new Map<string, { day: string; count: number }>();

function clientIp(c: { req: { header: (n: string) => string | undefined } }): string {
  // Prefer X-Real-IP (set by our nginx) over XFF leftmost (client-spoofable)
  return c.req.header("x-real-ip")?.trim()
    || c.req.header("x-forwarded-for")?.split(",").pop()?.trim()
    || "unknown";
}

function checkIpDailyLimit(ip: string): boolean {
  const day = new Date().toISOString().slice(0, 10);
  const entry = ipSendCounts.get(ip);
  if (!entry || entry.day !== day) return false;
  return entry.count >= emailCodes.RATE.IP_PER_DAY;
}

function recordIpSend(ip: string): void {
  const day = new Date().toISOString().slice(0, 10);
  const entry = ipSendCounts.get(ip);
  if (!entry || entry.day !== day) {
    ipSendCounts.set(ip, { day, count: 1 });
  } else {
    entry.count += 1;
  }
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

const SMTP_NOT_CONFIGURED = {
  error: {
    code: "smtp_not_configured",
    message: "平台未配置邮件服务，请联系管理员",
  },
};

function setSessionCookie(c: Parameters<typeof setCookie>[0], sessionId: string): void {
  setCookie(c, sessionCookieName(), sessionId, {
    httpOnly: true,
    sameSite: "Strict",
    path: "/",
    maxAge: COOKIE_MAX_AGE,
  });
}

function userPayload(user: authStorage.DbUser) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    role: user.role,
    mustChangePassword: user.must_change_password,
    source: user.source ?? "admin",
    onboarding_dismissed: user.onboarding_dismissed_at != null,
  };
}

export const authRouter = new Hono();

// POST /api/auth/login
authRouter.post("/login", licenseGuard, async (c) => {
  const body = await c.req.json<{ email: string; password: string }>();
  const ip = clientIp(c);
  const userAgent = c.req.header("user-agent");

  const result = await authService.login({
    email: body.email,
    password: body.password,
    ip,
    userAgent,
  });

  if ("error" in result) {
    if (result.error === "account_suspended") {
      return c.json({
        error: {
          code: "account_suspended",
          message: "账号已被禁用，请联系管理员",
        },
      }, 403);
    }
    const code = result.error === "locked" ? "ERR_AUTH_LOCKED" : "ERR_AUTH_INVALID_CREDENTIALS";
    return c.json({ error: { code } }, result.error === "locked" ? 429 : 401);
  }

  // Business service: reject admin accounts without leaking console existence.
  // Same shape as wrong password — no admin/后台/入口 hints on the public login form.
  const serviceRole = (process.env.SERVICE_ROLE ?? "business").toLowerCase();
  if (serviceRole !== "admin" && result.user.role === "admin") {
    await authService.logout(result.sessionId);
    return c.json({ error: { code: "ERR_AUTH_INVALID_CREDENTIALS" } }, 401);
  }

  setSessionCookie(c, result.sessionId);

  return c.json({
    ok: true,
    user: userPayload(result.user),
  });
});

// GET /api/auth/agreements — public catalog for register checkbox labels
authRouter.get("/agreements", licenseGuard, async (c) => {
  return c.json({ agreements: listRegisterAgreements() });
});

// GET /api/auth/agreements/:id — full HTML body for in-product viewer
authRouter.get("/agreements/:id", licenseGuard, async (c) => {
  const found = getAgreementHtml(c.req.param("id"));
  if (!found) return c.json({ error: { code: "ERR_NOT_FOUND" } }, 404);
  const format = c.req.query("format");
  if (format === "json") {
    return c.json({
      id: found.def.id,
      title: found.def.title,
      version: found.def.version,
      effective_date: found.def.effective_date,
      html: found.html,
    });
  }
  return c.html(found.html);
});

// POST /api/auth/register/request-code
authRouter.post("/register/request-code", licenseGuard, async (c) => {
  const body = await c.req.json<{ email?: string }>();
  const email = (body.email ?? "").trim().toLowerCase();
  if (!isValidEmail(email)) {
    return c.json({ error: { code: "invalid_email", message: "Invalid email" } }, 400);
  }
  if (!(await isSmtpConfigured())) {
    return c.json(SMTP_NOT_CONFIGURED, 501);
  }
  const ip = clientIp(c);
  if (checkIpDailyLimit(ip)) {
    return c.json({ error: { code: "rate_limited", message: "Too many requests from this IP" } }, 429);
  }
  const existing = await authStorage.findUserByEmail(email);
  if (existing) {
    // Do not leak existence on request-code? Contract allows register verify email_exists;
    // for request we still send only if free — return generic ok after cooldown check to reduce enum.
    // Spec table doesn't require hide on register request; keep simple:
    // still rate-limit and cooldown even when exists, but refuse to create code if exists.
  }
  const ageSec = await emailCodes.secondsSinceLastCode(email, "register");
  if (ageSec != null && ageSec < emailCodes.RATE.COOLDOWN_MS / 1000) {
    const remain = Math.ceil(emailCodes.RATE.COOLDOWN_MS / 1000 - ageSec);
    return c.json({ error: { code: "rate_limited", message: "Please wait before requesting another code", cooldown_seconds: remain } }, 429);
  }
  const dayCount = await emailCodes.countRecentByEmail(email, "register", 24 * 60 * 60_000);
  if (dayCount >= emailCodes.RATE.EMAIL_PER_DAY) {
    return c.json({ error: { code: "rate_limited", message: "Daily email code limit reached" } }, 429);
  }
  if (existing) {
    // Still consume rate window lightly: return ok with cooldown so attacker cannot enumerate easily
    // via differential timing — but contract verify returns 409. Prefer 409 early for UX on register.
    return c.json({ error: { code: "email_exists", message: "Email already registered" } }, 409);
  }
  const code = emailCodes.generateNumericCode();
  const { cooldownSeconds } = await emailCodes.insertCode(email, "register", code);
  const sent = await sendVerificationEmail({ to: email, code, purpose: "register" });
  if (!sent.ok) {
    return c.json({ error: { code: "smtp_send_failed", message: sent.error } }, 502);
  }
  recordIpSend(ip);
  return c.json({ ok: true, cooldown_seconds: cooldownSeconds });
});

// POST /api/auth/register/verify
authRouter.post("/register/verify", licenseGuard, async (c) => {
  const body = await c.req.json<{
    email?: string;
    code?: string;
    password?: string;
    display_name?: string;
    accept_agreements?: boolean;
  }>();
  const email = (body.email ?? "").trim().toLowerCase();
  const code = (body.code ?? "").trim();
  const password = body.password ?? "";
  if (!isValidEmail(email)) {
    return c.json({ error: { code: "invalid_email" } }, 400);
  }
  if (!(await isSmtpConfigured())) {
    return c.json(SMTP_NOT_CONFIGURED, 501);
  }
  if (!isStrongPassword(password)) {
    return c.json({ error: { code: "weak_password", message: PASSWORD_RULE_MESSAGE } }, 400);
  }
  if (body.accept_agreements !== true) {
    return c.json({
      error: {
        code: "agreements_required",
        message: "请先阅读并同意《用户服务协议》《隐私政策》和《SaaS 平台服务协议》",
      },
    }, 400);
  }
  const existing = await authStorage.findUserByEmail(email);
  if (existing) {
    return c.json({ error: { code: "email_exists", message: "Email already registered" } }, 409);
  }
  const verified = await emailCodes.verifyAndConsume(email, "register", code);
  if (!verified.ok) {
    return c.json({ error: { code: verified.error } }, 400);
  }
  const result = await authService.registerWithCode({
    email,
    password,
    displayName: body.display_name,
    ip: clientIp(c),
    userAgent: c.req.header("user-agent"),
  });
  await recordRegisterAcceptances(result.user.id);
  setSessionCookie(c, result.sessionId);
  return c.json({ user: userPayload(result.user), session: { ok: true } });
});

// POST /api/auth/password/forgot — always ok (no email enumeration)
authRouter.post("/password/forgot", licenseGuard, async (c) => {
  const body = await c.req.json<{ email?: string }>();
  const email = (body.email ?? "").trim().toLowerCase();
  if (!(await isSmtpConfigured())) {
    return c.json(SMTP_NOT_CONFIGURED, 501);
  }
  if (!isValidEmail(email)) {
    // Still ok shape for non-enum, but invalid email → 400 is fine
    return c.json({ error: { code: "invalid_email" } }, 400);
  }
  const ip = clientIp(c);
  if (checkIpDailyLimit(ip)) {
    return c.json({ error: { code: "rate_limited" } }, 429);
  }
  const ageSec = await emailCodes.secondsSinceLastCode(email, "reset");
  if (ageSec != null && ageSec < emailCodes.RATE.COOLDOWN_MS / 1000) {
    return c.json({ error: { code: "rate_limited", cooldown_seconds: Math.ceil(emailCodes.RATE.COOLDOWN_MS / 1000 - ageSec) } }, 429);
  }
  const dayCount = await emailCodes.countRecentByEmail(email, "reset", 24 * 60 * 60_000);
  if (dayCount >= emailCodes.RATE.EMAIL_PER_DAY) {
    return c.json({ error: { code: "rate_limited" } }, 429);
  }
  const user = await authStorage.findUserByEmail(email);
  if (user && user.status === "active") {
    const code = emailCodes.generateNumericCode();
    await emailCodes.insertCode(email, "reset", code);
    await sendVerificationEmail({ to: email, code, purpose: "reset" });
    recordIpSend(ip);
  } else {
    // burn a light rate slot to keep timing similar
    recordIpSend(ip);
  }
  return c.json({ ok: true });
});

// POST /api/auth/password/reset
authRouter.post("/password/reset", licenseGuard, async (c) => {
  const body = await c.req.json<{ email?: string; code?: string; new_password?: string }>();
  const email = (body.email ?? "").trim().toLowerCase();
  const code = (body.code ?? "").trim();
  const newPassword = body.new_password ?? "";
  if (!(await isSmtpConfigured())) {
    return c.json(SMTP_NOT_CONFIGURED, 501);
  }
  if (!isValidEmail(email)) {
    return c.json({ error: { code: "invalid_email" } }, 400);
  }
  if (!isStrongPassword(newPassword)) {
    return c.json({ error: { code: "weak_password", message: PASSWORD_RULE_MESSAGE } }, 400);
  }
  const verified = await emailCodes.verifyAndConsume(email, "reset", code);
  if (!verified.ok) {
    return c.json({ error: { code: verified.error } }, 400);
  }
  const user = await authStorage.findUserByEmail(email);
  if (!user) {
    return c.json({ error: { code: "invalid_code" } }, 400);
  }
  await authService.resetPasswordWithCode(user.id, newPassword);
  return c.json({ ok: true });
});

// POST /api/auth/change-password (personal, requires old password)
authRouter.post("/change-password", licenseGuard, requireAuth, async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ old_password: string; new_password: string }>();

  if (!body.old_password || !body.new_password || !isStrongPassword(body.new_password)) {
    return c.json({ error: { code: "weak_password", message: PASSWORD_RULE_MESSAGE } }, 400);
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

  if (!body.new_password || !isStrongPassword(body.new_password)) {
    return c.json({ error: { code: "weak_password", message: PASSWORD_RULE_MESSAGE } }, 400);
  }

  await authService.forceChangePassword(user.userId, body.new_password);
  // forceChange wiped all sessions — mint a fresh one so the user stays signed in
  // for the first-login flow, while any other devices are kicked.
  const ip = clientIp(c);
  const userAgent = c.req.header("user-agent");
  const fresh = await authStorage.createSession({
    userId: user.userId,
    ip,
    userAgent,
  });
  setSessionCookie(c, fresh);
  return c.json({ ok: true });
});

// PATCH /api/auth/me — self-update display_name + onboarding dismiss
authRouter.patch("/me", licenseGuard, requireAuth, async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ display_name?: string; onboarding_dismissed?: boolean }>();
  if (body.display_name !== undefined) {
    await authStorage.updateUser(user.userId, { displayName: body.display_name });
  }
  // Only accept true (one-way); ignore false/other values
  if (body.onboarding_dismissed === true) {
    await authStorage.dismissOnboarding(user.userId);
  }
  return c.json({ ok: true });
});

// POST /api/auth/logout
authRouter.post("/logout", async (c) => {
  const sessionId = getCookie(c, sessionCookieName());
  if (sessionId) {
    await authService.logout(sessionId);
  }
  deleteCookie(c, sessionCookieName(), { path: "/" });
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

/**
 * admin-api auth subset: login / logout / me / change-password / force-change-password.
 * No register, request-code, bootstrap, forgot-password.
 */
export const adminAuthRouter = new Hono();

adminAuthRouter.post("/login", licenseGuard, async (c) => {
  const body = await c.req.json<{ email: string; password: string }>();
  const ip = clientIp(c);
  const userAgent = c.req.header("user-agent");

  const result = await authService.login({
    email: body.email,
    password: body.password,
    ip,
    userAgent,
  });

  if ("error" in result) {
    if (result.error === "account_suspended") {
      return c.json({
        error: {
          code: "account_suspended",
          message: "账号已被禁用，请联系管理员",
        },
      }, 403);
    }
    const code = result.error === "locked" ? "ERR_AUTH_LOCKED" : "ERR_AUTH_INVALID_CREDENTIALS";
    return c.json({ error: { code } }, result.error === "locked" ? 429 : 401);
  }

  setSessionCookie(c, result.sessionId);
  return c.json({
    ok: true,
    user: userPayload(result.user),
  });
});

adminAuthRouter.post("/change-password", licenseGuard, requireAuth, async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ old_password: string; new_password: string }>();

  if (!body.old_password || !body.new_password || !isStrongPassword(body.new_password)) {
    return c.json({ error: { code: "weak_password", message: PASSWORD_RULE_MESSAGE } }, 400);
  }

  const result = await authService.changePassword(user.userId, body.old_password, body.new_password);
  if ("error" in result) {
    return c.json({ error: { code: "ERR_AUTH_INVALID_CREDENTIALS", message: result.error } }, 401);
  }
  return c.json({ ok: true });
});

adminAuthRouter.post("/force-change-password", licenseGuard, requireAuth, async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ new_password: string }>();

  if (!body.new_password || !isStrongPassword(body.new_password)) {
    return c.json({ error: { code: "weak_password", message: PASSWORD_RULE_MESSAGE } }, 400);
  }

  await authService.forceChangePassword(user.userId, body.new_password);
  const ip = clientIp(c);
  const userAgent = c.req.header("user-agent");
  const fresh = await authStorage.createSession({
    userId: user.userId,
    ip,
    userAgent,
  });
  setSessionCookie(c, fresh);
  return c.json({ ok: true });
});

adminAuthRouter.patch("/me", licenseGuard, requireAuth, async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ display_name?: string; onboarding_dismissed?: boolean }>();
  if (body.display_name !== undefined) {
    await authStorage.updateUser(user.userId, { displayName: body.display_name });
  }
  if (body.onboarding_dismissed === true) {
    await authStorage.dismissOnboarding(user.userId);
  }
  return c.json({ ok: true });
});

adminAuthRouter.post("/logout", async (c) => {
  const sessionId = getCookie(c, sessionCookieName());
  if (sessionId) {
    await authService.logout(sessionId);
  }
  deleteCookie(c, sessionCookieName(), { path: "/" });
  return c.json({ ok: true });
});
