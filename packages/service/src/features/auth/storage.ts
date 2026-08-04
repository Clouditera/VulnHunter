import { getDb } from "../../infra/db/client.js";

const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";

export interface DbUser {
  id: string;
  tenant_id: string;
  email: string;
  password_hash: string;
  role: string;
  status: string;
  source: string;
  display_name: string;
  admin_remark: string | null;
  must_change_password: boolean;
  task_limit: number;
  sandbox_max_running: number;
  sandbox_max_cpu_cores: number;
  sandbox_max_memory_gb: number;
  last_login_at: Date | null;
  /** Set when user dismisses first-run onboarding (migration 040). */
  onboarding_dismissed_at: Date | null;
  /** Deploy-provisioned system admin — cannot disable/delete/demote (044). */
  is_system: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface DbSession {
  id: string;
  tenant_id: string;
  user_id: string;
  expires_at: Date;
}

export async function findUserByEmail(email: string): Promise<DbUser | null> {
  const db = getDb();
  const rows = await db<DbUser[]>`
    SELECT *
    FROM users
    WHERE tenant_id = ${DEFAULT_TENANT_ID} AND email = ${email}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function createUser(params: {
  email: string;
  passwordHash: string;
  role: "admin" | "member";
  displayName?: string;
  adminRemark?: string | null;
  mustChangePassword?: boolean;
  taskLimit?: number;
  sandboxMaxRunning?: number;
  sandboxMaxCpuCores?: number;
  sandboxMaxMemoryGb?: number;
  source?: "admin" | "registered";
  isSystem?: boolean;
}): Promise<DbUser> {
  const db = getDb();
  const rows = await db<DbUser[]>`
    INSERT INTO users (tenant_id, email, password_hash, role, display_name, admin_remark, must_change_password, task_limit, sandbox_max_running, sandbox_max_cpu_cores, sandbox_max_memory_gb, source, is_system)
    VALUES (
      ${DEFAULT_TENANT_ID},
      ${params.email},
      ${params.passwordHash},
      ${params.role},
      ${params.displayName ?? params.email.split("@")[0]},
      ${params.adminRemark ?? null},
      ${params.mustChangePassword ?? false},
      ${params.taskLimit ?? 0},
      ${params.sandboxMaxRunning ?? 0},
      ${params.sandboxMaxCpuCores ?? 0},
      ${params.sandboxMaxMemoryGb ?? 0},
      ${params.source ?? "admin"},
      ${params.isSystem ?? false}
    )
    RETURNING *
  `;
  return rows[0];
}

export async function hasAnyAdmin(): Promise<boolean> {
  const db = getDb();
  const rows = await db<{ count: string }[]>`
    SELECT COUNT(*) as count FROM users
    WHERE tenant_id = ${DEFAULT_TENANT_ID} AND role = 'admin'
  `;
  return Number(rows[0].count) > 0;
}

export async function createSession(params: {
  userId: string;
  ip?: string;
  userAgent?: string;
}): Promise<string> {
  const db = getDb();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days
  const rows = await db<{ id: string }[]>`
    INSERT INTO sessions (tenant_id, user_id, expires_at, ip, user_agent)
    VALUES (${DEFAULT_TENANT_ID}, ${params.userId}, ${expiresAt}, ${params.ip ?? null}, ${params.userAgent ?? null})
    RETURNING id
  `;
  return rows[0].id;
}

export async function findSession(sessionId: string): Promise<DbSession | null> {
  const db = getDb();
  const rows = await db<DbSession[]>`
    SELECT id, tenant_id, user_id, expires_at
    FROM sessions
    WHERE id = ${sessionId} AND expires_at > now()
    LIMIT 1
  `;
  if (!rows[0]) return null;

  // Slide expiry
  await db`
    UPDATE sessions SET last_seen = now(), expires_at = now() + interval '30 days'
    WHERE id = ${sessionId}
  `;
  return rows[0];
}

export async function deleteSession(sessionId: string): Promise<void> {
  const db = getDb();
  await db`DELETE FROM sessions WHERE id = ${sessionId}`;
}

export async function getUserById(userId: string): Promise<DbUser | null> {
  const db = getDb();
  const rows = await db<DbUser[]>`
    SELECT * FROM users WHERE id = ${userId} LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function listUsersByIds(userIds: string[]): Promise<Pick<DbUser, "id" | "email" | "display_name">[]> {
  if (userIds.length === 0) return [];
  const db = getDb();
  return db<Pick<DbUser, "id" | "email" | "display_name">[]>`
    SELECT id, email, display_name
    FROM users
    WHERE id = ANY(${userIds})
  `;
}

export async function listUsers(): Promise<DbUser[]> {
  const db = getDb();
  return db<DbUser[]>`
    SELECT * FROM users
    WHERE tenant_id = ${DEFAULT_TENANT_ID}
    ORDER BY created_at ASC
  `;
}

export async function updateUser(
  id: string,
  fields: {
    displayName?: string;
    role?: string;
    status?: string;
    passwordHash?: string;
    mustChangePassword?: boolean;
    taskLimit?: number;
    sandboxMaxRunning?: number;
    sandboxMaxCpuCores?: number;
    sandboxMaxMemoryGb?: number;
    adminRemark?: string | null;
    /** Internal: provisionSystemAdmin only */
    isSystem?: boolean;
  },
): Promise<void> {
  const db = getDb();
  const target = await getUserById(id);
  if (target?.is_system) {
    // System admin: block disable/demote/delete-equivalent. Password rewrite is
    // allowed only when isSystem is also being forced true (provision path).
    const statusBad = fields.status !== undefined && fields.status !== "active";
    const roleBad = fields.role !== undefined && fields.role !== "admin";
    const pwdFromUi = fields.passwordHash !== undefined && fields.isSystem !== true;
    if (statusBad || roleBad || pwdFromUi) {
      const err = new Error("ERR_PROTECTED_ACCOUNT") as Error & { code: string };
      err.code = "ERR_PROTECTED_ACCOUNT";
      throw err;
    }
  }
  const updateAdminRemark = Object.prototype.hasOwnProperty.call(fields, "adminRemark");
  const updateIsSystem = Object.prototype.hasOwnProperty.call(fields, "isSystem");
  await db`
    UPDATE users SET
      display_name = COALESCE(${fields.displayName ?? null}, display_name),
      role = COALESCE(${fields.role ?? null}, role),
      status = COALESCE(${fields.status ?? null}, status),
      password_hash = COALESCE(${fields.passwordHash ?? null}, password_hash),
      must_change_password = COALESCE(${fields.mustChangePassword ?? null}, must_change_password),
      task_limit = COALESCE(${fields.taskLimit ?? null}, task_limit),
      sandbox_max_running = COALESCE(${fields.sandboxMaxRunning ?? null}, sandbox_max_running),
      sandbox_max_cpu_cores = COALESCE(${fields.sandboxMaxCpuCores ?? null}, sandbox_max_cpu_cores),
      sandbox_max_memory_gb = COALESCE(${fields.sandboxMaxMemoryGb ?? null}, sandbox_max_memory_gb),
      admin_remark = CASE WHEN ${updateAdminRemark} THEN ${fields.adminRemark ?? null} ELSE admin_remark END,
      is_system = CASE WHEN ${updateIsSystem} THEN ${fields.isSystem ?? false} ELSE is_system END,
      updated_at = now()
    WHERE id = ${id}
  `;
}

/** Idempotent: set onboarding_dismissed_at = now() if not already set. */
export async function dismissOnboarding(userId: string): Promise<void> {
  const db = getDb();
  await db`
    UPDATE users SET
      onboarding_dismissed_at = COALESCE(onboarding_dismissed_at, now()),
      updated_at = now()
    WHERE id = ${userId}
  `;
}

export async function deleteUser(id: string): Promise<void> {
  const target = await getUserById(id);
  if (target?.is_system) {
    const err = new Error("ERR_PROTECTED_ACCOUNT") as Error & { code: string };
    err.code = "ERR_PROTECTED_ACCOUNT";
    throw err;
  }
  const db = getDb();
  // Architect A: app-level cleanup in one transaction (FK NO ACTION blockers).
  await db.begin(async (tx) => {
    // Keep tasks; clear creator (column nullable via migration 041).
    await tx`UPDATE tasks SET created_by = NULL WHERE created_by = ${id}`;
    // Review history: drop actor rows / clear reviewed_by
    await tx`DELETE FROM finding_review_events WHERE user_id = ${id}`;
    await tx`UPDATE findings_meta SET reviewed_by = NULL WHERE reviewed_by = ${id}`;
    // User-generated reports
    await tx`DELETE FROM user_reports WHERE created_by = ${id}`;
    // Report skills: owner CASCADE covers most; delete any leftover uploaded_by rows
    await tx`DELETE FROM report_skills WHERE uploaded_by = ${id} OR owner_user_id = ${id}`;
    // Login sessions
    await tx`DELETE FROM sessions WHERE user_id = ${id}`;
    // chat_sessions / credentials / agreements CASCADE on user delete
    await tx`DELETE FROM users WHERE id = ${id}`;
  });
}

export async function deleteAllSessionsForUser(userId: string): Promise<void> {
  const db = getDb();
  await db`DELETE FROM sessions WHERE user_id = ${userId}`;
}

export async function countAdmins(): Promise<number> {
  const db = getDb();
  const rows = await db<{ count: string }[]>`
    SELECT COUNT(*) as count FROM users
    WHERE tenant_id = ${DEFAULT_TENANT_ID} AND role = 'admin' AND status = 'active'
  `;
  return Number(rows[0].count);
}

export async function updateLastLogin(userId: string): Promise<void> {
  const db = getDb();
  await db`UPDATE users SET last_login_at = now() WHERE id = ${userId}`;
}
