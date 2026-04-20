import bcrypt from "bcrypt";
import { logger } from "../../infra/logger.js";
import * as storage from "./storage.js";

const BCRYPT_COST = 12;

// In-memory login attempt tracker (acceptable for single-instance v1.0)
const loginAttempts = new Map<string, { count: number; lockedUntil: number }>();
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

function getLockoutKey(ip: string, email: string): string {
  return `${ip}:${email}`;
}

function checkLockout(ip: string, email: string): boolean {
  const key = getLockoutKey(ip, email);
  const entry = loginAttempts.get(key);
  if (!entry) return false;
  if (entry.lockedUntil > Date.now()) return true;
  if (entry.count >= MAX_ATTEMPTS) return true;
  return false;
}

function recordFailedAttempt(ip: string, email: string): void {
  const key = getLockoutKey(ip, email);
  const entry = loginAttempts.get(key) ?? { count: 0, lockedUntil: 0 };
  entry.count++;
  if (entry.count >= MAX_ATTEMPTS) {
    entry.lockedUntil = Date.now() + LOCKOUT_MS;
  }
  loginAttempts.set(key, entry);
}

function clearAttempts(ip: string, email: string): void {
  loginAttempts.delete(getLockoutKey(ip, email));
}

export async function login(params: {
  email: string;
  password: string;
  ip?: string;
  userAgent?: string;
}): Promise<{ sessionId: string } | { error: "locked" | "invalid_credentials" }> {
  const ip = params.ip ?? "unknown";

  if (checkLockout(ip, params.email)) {
    return { error: "locked" };
  }

  const user = await storage.findUserByEmail(params.email);
  if (!user || user.status !== "active") {
    recordFailedAttempt(ip, params.email);
    return { error: "invalid_credentials" };
  }

  const valid = await bcrypt.compare(params.password, user.password_hash);
  if (!valid) {
    recordFailedAttempt(ip, params.email);
    return { error: "invalid_credentials" };
  }

  clearAttempts(ip, params.email);
  const sessionId = await storage.createSession({
    userId: user.id,
    ip: params.ip,
    userAgent: params.userAgent,
  });

  logger.info({ userId: user.id, email: user.email }, "User logged in");
  return { sessionId };
}

export async function logout(sessionId: string): Promise<void> {
  await storage.deleteSession(sessionId);
}

export async function resolveSession(sessionId: string) {
  const session = await storage.findSession(sessionId);
  if (!session) return null;
  const user = await storage.getUserById(session.user_id);
  if (!user || user.status !== "active") return null;
  return {
    userId: user.id,
    tenantId: user.tenant_id,
    email: user.email,
    role: user.role as "admin" | "member",
    sessionId: session.id,
  };
}

export async function bootstrap(params: {
  email: string;
  password: string;
}): Promise<{ success: boolean; error?: string }> {
  const alreadyHasAdmin = await storage.hasAnyAdmin();
  if (alreadyHasAdmin) {
    return { success: false, error: "admin_exists" };
  }

  const passwordHash = await bcrypt.hash(params.password, BCRYPT_COST);
  await storage.createUser({
    email: params.email,
    passwordHash,
    role: "admin",
  });

  logger.info({ email: params.email }, "Admin account created via bootstrap");
  return { success: true };
}

export { hasAnyAdmin } from "./storage.js";
