import bcrypt from "bcrypt";
import { logger } from "../../infra/logger.js";
import * as storage from "./storage.js";

const BCRYPT_COST = 12;

// In-memory login attempt tracker (acceptable for single-instance v1.0)
const loginAttempts = new Map<string, { count: number; lockedUntil: number }>();
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

function getLockoutKey(ip: string, email: string): string {
  return `${ip}:${email.toLowerCase()}`;
}

/**
 * True while lockout window is active.
 * After lockedUntil elapses, the entry is cleared so the user can try again
 * (bugfix: previously `count >= MAX` kept the account locked forever).
 */
function checkLockout(ip: string, email: string, now = Date.now()): boolean {
  const key = getLockoutKey(ip, email);
  const entry = loginAttempts.get(key);
  if (!entry) return false;
  if (entry.lockedUntil > now) return true;
  // Window expired (or never locked) — drop stale counter so attempts restart.
  if (entry.lockedUntil > 0 && entry.lockedUntil <= now) {
    loginAttempts.delete(key);
    return false;
  }
  return false;
}

function recordFailedAttempt(ip: string, email: string, now = Date.now()): void {
  const key = getLockoutKey(ip, email);
  // If a previous lockout already expired, start fresh before counting.
  checkLockout(ip, email, now);
  const entry = loginAttempts.get(key) ?? { count: 0, lockedUntil: 0 };
  entry.count++;
  if (entry.count >= MAX_ATTEMPTS) {
    entry.lockedUntil = now + LOCKOUT_MS;
  }
  loginAttempts.set(key, entry);
}

function clearAttempts(ip: string, email: string): void {
  loginAttempts.delete(getLockoutKey(ip, email));
}

/** Test / ops hooks (in-memory only — not a DB). */
export function _resetLoginAttemptsForTests(): void {
  loginAttempts.clear();
}

export function _getLoginAttemptEntryForTests(ip: string, email: string) {
  return loginAttempts.get(getLockoutKey(ip, email)) ?? null;
}

/** Ops: clear lockout for one email (all IPs that keyed it). Returns cleared key count. */
export function clearLoginLockoutForEmail(email: string): number {
  const needle = `:${email.toLowerCase()}`;
  let n = 0;
  for (const key of [...loginAttempts.keys()]) {
    if (key.toLowerCase().endsWith(needle)) {
      loginAttempts.delete(key);
      n++;
    }
  }
  return n;
}

export const LOGIN_LOCKOUT = { MAX_ATTEMPTS, LOCKOUT_MS } as const;

export async function login(params: {
  email: string;
  password: string;
  ip?: string;
  userAgent?: string;
}): Promise<
  | { sessionId: string; user: storage.DbUser }
  | { error: "locked" | "invalid_credentials" | "account_suspended" }
> {
  const ip = params.ip ?? "unknown";

  if (checkLockout(ip, params.email)) {
    return { error: "locked" };
  }

  const user = await storage.findUserByEmail(params.email);
  if (!user) {
    recordFailedAttempt(ip, params.email);
    return { error: "invalid_credentials" };
  }
  if (user.status === "suspended") {
    return { error: "account_suspended" };
  }
  if (user.status !== "active") {
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
  source?: "admin" | "registered";
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
    source: params.source ?? "admin",
  });
}

export async function registerWithCode(params: {
  email: string;
  password: string;
  displayName?: string;
  ip?: string;
  userAgent?: string;
}): Promise<{ sessionId: string; user: storage.DbUser }> {
  const user = await createUserAccount({
    email: params.email.toLowerCase(),
    password: params.password,
    displayName: params.displayName,
    role: "member",
    mustChangePassword: false,
    source: "registered",
  });
  const sessionId = await storage.createSession({
    userId: user.id,
    ip: params.ip,
    userAgent: params.userAgent,
  });
  await storage.updateLastLogin(user.id);
  logger.info({ userId: user.id, email: user.email }, "User registered");
  return { sessionId, user };
}

export async function resetPasswordWithCode(userId: string, newPassword: string): Promise<void> {
  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST);
  await storage.updateUser(userId, { passwordHash, mustChangePassword: false });
  await storage.deleteAllSessionsForUser(userId);
  logger.info({ userId }, "Password reset via email code; sessions invalidated");
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
  await storage.deleteAllSessionsForUser(userId);
  logger.info({ userId }, "Password changed; sessions invalidated");
  return { ok: true };
}

export async function forceChangePassword(userId: string, newPassword: string): Promise<void> {
  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST);
  await storage.updateUser(userId, { passwordHash, mustChangePassword: false });
  // Invalidate all sessions; caller should mint a fresh session cookie for the current client.
  await storage.deleteAllSessionsForUser(userId);
  logger.info({ userId }, "Password force-changed; sessions invalidated");
}

export { hasAnyAdmin } from "./storage.js";
