import { getDb } from "../../infra/db/client.js";

const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";

export interface DbChatSession {
  id: string;
  tenant_id: string;
  user_id: string;
  title: string;
  worker_state: string;
  worker_container_id: string | null;
  session_minio_key: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface DbChatMessage {
  id: string;
  session_id: string;
  role: "user" | "assistant";
  content: string;
  seq: number;
  tool_calls: unknown[] | null;
  created_at: Date;
}

export async function createSession(userId: string, title?: string): Promise<DbChatSession> {
  const db = getDb();
  const rows = await db<DbChatSession[]>`
    INSERT INTO chat_sessions (tenant_id, user_id, title)
    VALUES (${DEFAULT_TENANT_ID}, ${userId}, ${title ?? "New Chat"})
    RETURNING *
  `;
  return rows[0];
}

export async function listSessions(userId: string): Promise<DbChatSession[]> {
  const db = getDb();
  return db<DbChatSession[]>`
    SELECT * FROM chat_sessions
    WHERE user_id = ${userId}
    ORDER BY updated_at DESC
    LIMIT 50
  `;
}

export async function getSession(id: string): Promise<DbChatSession | null> {
  const db = getDb();
  const rows = await db<DbChatSession[]>`SELECT * FROM chat_sessions WHERE id = ${id}`;
  return rows[0] ?? null;
}

export async function deleteSession(id: string): Promise<void> {
  const db = getDb();
  await db`DELETE FROM chat_sessions WHERE id = ${id}`;
}

export async function updateSessionTimestamp(id: string): Promise<void> {
  const db = getDb();
  await db`UPDATE chat_sessions SET updated_at = now() WHERE id = ${id}`;
}

export async function appendMessage(params: {
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  toolCalls?: unknown[];
}): Promise<DbChatMessage> {
  const db = getDb();
  // Get session to find tenant_id and user_id
  const session = await getSession(params.sessionId);
  if (!session) throw new Error("Session not found");

  // Get next seq
  const seqRows = await db<{ max: number | null }[]>`
    SELECT MAX(seq) as max FROM chat_messages WHERE session_id = ${params.sessionId}
  `;
  const nextSeq = (seqRows[0]?.max ?? 0) + 1;

  const rows = await db<DbChatMessage[]>`
    INSERT INTO chat_messages (session_id, tenant_id, user_id, role, content, seq)
    VALUES (${params.sessionId}, ${session.tenant_id}, ${session.user_id},
            ${params.role}, ${params.content}, ${nextSeq})
    RETURNING *
  `;
  return rows[0];
}

export async function listMessages(sessionId: string, sinceSeq?: number): Promise<DbChatMessage[]> {
  const db = getDb();
  if (sinceSeq != null) {
    return db<DbChatMessage[]>`
      SELECT * FROM chat_messages
      WHERE session_id = ${sessionId} AND seq > ${sinceSeq}
      ORDER BY seq ASC
    `;
  }
  return db<DbChatMessage[]>`
    SELECT * FROM chat_messages
    WHERE session_id = ${sessionId}
    ORDER BY seq ASC
    LIMIT 200
  `;
}
