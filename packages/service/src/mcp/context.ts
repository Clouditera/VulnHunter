/**
 * MCP Context resolution — binds every tool call to a real user identity.
 * Token can be a chat session ID or report ID.
 */
import { getDb } from "../infra/db/client.js";

export type McpActorType = "chat" | "report";

export interface McpContext {
  actorType: McpActorType;
  token: string;
  sessionId?: string;
  reportId?: string;
  userId: string;
  tenantId: string;
  role: "admin" | "user";
}

/**
 * Resolve a Bearer token to a typed MCP context.
 * Returns null if token is invalid.
 */
export async function resolveMcpContext(token: string): Promise<McpContext | null> {
  const db = getDb();

  // Try chat session first
  const chatRows = await db<{ id: string; user_id: string; tenant_id: string }[]>`
    SELECT cs.id, cs.user_id, cs.tenant_id
    FROM chat_sessions cs
    WHERE cs.id = ${token}
    LIMIT 1
  `;
  if (chatRows.length > 0) {
    const session = chatRows[0];
    const userRows = await db<{ role: string }[]>`
      SELECT role FROM users WHERE id = ${session.user_id} LIMIT 1
    `;
    return {
      actorType: "chat",
      token,
      sessionId: session.id,
      userId: session.user_id,
      tenantId: session.tenant_id,
      role: (userRows[0]?.role as "admin" | "user") ?? "user",
    };
  }

  // Try report ID
  const reportRows = await db<{ id: string; task_id: string; created_by: string; tenant_id: string }[]>`
    SELECT ur.id, ur.task_id, ur.created_by, ur.tenant_id
    FROM user_reports ur
    WHERE ur.id = ${token}
    LIMIT 1
  `;
  if (reportRows.length > 0) {
    const report = reportRows[0];
    const userRows = await db<{ role: string }[]>`
      SELECT role FROM users WHERE id = ${report.created_by} LIMIT 1
    `;
    return {
      actorType: "report",
      token,
      reportId: report.id,
      userId: report.created_by,
      tenantId: report.tenant_id,
      role: (userRows[0]?.role as "admin" | "user") ?? "user",
    };
  }

  return null;
}
