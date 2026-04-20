import { getDb } from "../../infra/db/client.js";

const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";

export interface DbUser {
  id: string;
  tenant_id: string;
  email: string;
  password_hash: string;
  role: string;
  status: string;
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
    SELECT id, tenant_id, email, password_hash, role, status
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
}): Promise<DbUser> {
  const db = getDb();
  const rows = await db<DbUser[]>`
    INSERT INTO users (tenant_id, email, password_hash, role)
    VALUES (${DEFAULT_TENANT_ID}, ${params.email}, ${params.passwordHash}, ${params.role})
    RETURNING id, tenant_id, email, password_hash, role, status
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
    SELECT id, tenant_id, email, password_hash, role, status
    FROM users WHERE id = ${userId} LIMIT 1
  `;
  return rows[0] ?? null;
}
