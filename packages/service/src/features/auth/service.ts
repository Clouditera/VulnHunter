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
}): Promise<{ sessionId: string; user: storage.DbUser } | { error: "locked" | "invalid_credentials" }> {
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

  // Update last login timestamp
  await storage.updateLastLogin(user.id);

  logger.info({ userId: user.id, email: user.email }, "User logged in");
  return { sessionId, user };
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
    displayName: user.display_name,
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

export async function createUserAccount(params: {
  email: string;
  password: string;
  displayName?: string;
  role: "admin" | "member";
  mustChangePassword?: boolean;
  taskLimit?: number;
  sandboxMaxRunning?: number;
  sandboxMaxCpuCores?: number;
  sandboxMaxMemoryGb?: number;
  adminRemark?: string | null;
}): Promise<storage.DbUser> {
  const passwordHash = await bcrypt.hash(params.password, BCRYPT_COST);
  return storage.createUser({
    email: params.email,
    passwordHash,
    role: params.role,
    displayName: params.displayName,
    mustChangePassword: params.mustChangePassword ?? true,
    taskLimit: params.taskLimit ?? 0,
    sandboxMaxRunning: params.sandboxMaxRunning ?? 0,
    sandboxMaxCpuCores: params.sandboxMaxCpuCores ?? 0,
    sandboxMaxMemoryGb: params.sandboxMaxMemoryGb ?? 0,
    adminRemark: params.adminRemark ?? null,
  });
}

export async function changePassword(
  userId: string,
  oldPassword: string,
  newPassword: string,
): Promise<{ ok: true } | { error: string }> {
  const user = await storage.getUserById(userId);
  if (!user) return { error: "User not found" };

  const valid = await bcrypt.compare(oldPassword, user.password_hash);
  if (!valid) return { error: "Invalid current password" };

  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST);
  await storage.updateUser(userId, { passwordHash, mustChangePassword: false });
  logger.info({ userId }, "Password changed");
  return { ok: true };
}

export async function forceChangePassword(userId: string, newPassword: string): Promise<void> {
  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST);
  await storage.updateUser(userId, { passwordHash, mustChangePassword: false });
  logger.info({ userId }, "Password force-changed (first login)");
}

export { hasAnyAdmin } from "./storage.js";
