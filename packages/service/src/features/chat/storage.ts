import { getDb } from "../../infra/db/client.js";
import type { QueryContext } from "../../infra/query-context.js";
import { shouldFilterByUser } from "../../infra/query-context.js";

const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";

/** Empty sessions older than this are deleted on list/search (architect GC). */
const EMPTY_SESSION_GRACE_MS = 60 * 60 * 1000;

/** Inline GC: zero-message sessions past grace window. Bounded, no daemon. */
export async function purgeStaleEmptySessions(tenantId = DEFAULT_TENANT_ID): Promise<number> {
  const db = getDb();
  const cutoff = new Date(Date.now() - EMPTY_SESSION_GRACE_MS);
  const rows = await db<{ id: string }[]>`
    DELETE FROM chat_sessions s
    WHERE s.tenant_id = ${tenantId}
      AND s.created_at < ${cutoff}
      AND NOT EXISTS (SELECT 1 FROM chat_messages m WHERE m.session_id = s.id)
    RETURNING s.id
  `;
  return rows.length;
}


export interface DbChatSession {
  id: string;
  tenant_id: string;
  user_id: string;
  title: string;
  worker_state: string;
  worker_container_id: string | null;
  session_minio_key: string | null;
  credential_id: string | null;
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

export async function createSession(userId: string, title?: string, credentialId?: string, tenantId = DEFAULT_TENANT_ID): Promise<DbChatSession> {
  const db = getDb();
  const rows = await db<DbChatSession[]>`
    INSERT INTO chat_sessions (tenant_id, user_id, title, credential_id)
    VALUES (${tenantId}, ${userId}, ${title ?? "New Chat"}, ${credentialId ?? null})
    RETURNING *
  `;
  return rows[0];
}

export async function listSessions(ctx: QueryContext): Promise<DbChatSession[]>;
export async function listSessions(userId: string): Promise<DbChatSession[]>;
export async function listSessions(ctxOrUserId: QueryContext | string): Promise<DbChatSession[]> {
  const db = getDb();
  if (typeof ctxOrUserId === "string") {
    return db<DbChatSession[]>`
      SELECT * FROM chat_sessions
      WHERE user_id = ${ctxOrUserId}
        AND EXISTS (SELECT 1 FROM chat_messages m WHERE m.session_id = chat_sessions.id)
      ORDER BY updated_at DESC
      LIMIT 50
    `;
  }
  await purgeStaleEmptySessions(ctxOrUserId.tenantId);
  if (shouldFilterByUser(ctxOrUserId)) {
    return db<DbChatSession[]>`
      SELECT * FROM chat_sessions
      WHERE tenant_id = ${ctxOrUserId.tenantId} AND user_id = ${ctxOrUserId.userId}
        AND EXISTS (SELECT 1 FROM chat_messages m WHERE m.session_id = chat_sessions.id)
      ORDER BY updated_at DESC
      LIMIT 50
    `;
  }
  return db<DbChatSession[]>`
    SELECT * FROM chat_sessions
    WHERE tenant_id = ${ctxOrUserId.tenantId}
      AND EXISTS (SELECT 1 FROM chat_messages m WHERE m.session_id = chat_sessions.id)
    ORDER BY updated_at DESC
    LIMIT 50
  `;
}

export async function getSession(id: string): Promise<DbChatSession | null> {
  const db = getDb();
  const rows = await db<DbChatSession[]>`SELECT * FROM chat_sessions WHERE id = ${id}`;
  return rows[0] ?? null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getSessionForContext(id: string, ctx: QueryContext): Promise<DbChatSession | null> {
  // Guard: non-UUID ids (e.g. the literal "draft" placeholder) must not reach
  // Postgres — a uuid-typed column comparison would throw 22P02 → ERR_INTERNAL.
  // Treat them as not-found so callers return a clean 404.
  if (!UUID_RE.test(id)) return null;
  const db = getDb();
  const rows = shouldFilterByUser(ctx)
    ? await db<DbChatSession[]>`
      SELECT * FROM chat_sessions
      WHERE id = ${id} AND tenant_id = ${ctx.tenantId} AND user_id = ${ctx.userId}
      LIMIT 1
    `
    : await db<DbChatSession[]>`
      SELECT * FROM chat_sessions
      WHERE id = ${id} AND tenant_id = ${ctx.tenantId}
      LIMIT 1
    `;
  return rows[0] ?? null;
}

export async function getSessionForUser(id: string, userId: string): Promise<DbChatSession | null> {
  const db = getDb();
  const rows = await db<DbChatSession[]>`
    SELECT * FROM chat_sessions
    WHERE id = ${id} AND user_id = ${userId}
    LIMIT 1
  `;
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

export async function updateSessionCredential(id: string, credentialId: string): Promise<void> {
  const db = getDb();
  await db`UPDATE chat_sessions SET credential_id = ${credentialId}, updated_at = now() WHERE id = ${id}`;
}

export async function updateSessionTitleIfDefault(id: string, title: string, defaultTitles: string[]): Promise<boolean> {
  const db = getDb();
  const rows = await db<{ id: string }[]>`
    UPDATE chat_sessions
    SET title = ${title}, updated_at = now()
    WHERE id = ${id} AND (title IS NULL OR btrim(title) = ANY(${defaultTitles}))
    RETURNING id
  `;
  return rows.length > 0;
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
    INSERT INTO chat_messages (session_id, tenant_id, user_id, role, content, seq, tool_calls)
    VALUES (${params.sessionId}, ${session.tenant_id}, ${session.user_id},
            ${params.role}, ${params.content}, ${nextSeq},
            ${params.toolCalls && params.toolCalls.length > 0 ? db.json(params.toolCalls as never) : null})
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


export interface ListSessionsPage {
  sessions: DbChatSession[];
  next_offset: number | null;
  total: number;
}

export async function listSessionsPage(
  ctx: QueryContext,
  opts?: { limit?: number; offset?: number },
): Promise<ListSessionsPage> {
  const db = getDb();
  const limit = Math.min(Math.max(opts?.limit ?? 20, 1), 100);
  const offset = Math.max(opts?.offset ?? 0, 0);
  await purgeStaleEmptySessions(ctx.tenantId);

  const totalRows = shouldFilterByUser(ctx)
    ? await db<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM chat_sessions
        WHERE tenant_id = ${ctx.tenantId} AND user_id = ${ctx.userId}
          AND EXISTS (SELECT 1 FROM chat_messages m WHERE m.session_id = chat_sessions.id)
      `
    : await db<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM chat_sessions
        WHERE tenant_id = ${ctx.tenantId}
          AND EXISTS (SELECT 1 FROM chat_messages m WHERE m.session_id = chat_sessions.id)
      `;
  const total = Number(totalRows[0]?.count ?? 0);

  const sessions = shouldFilterByUser(ctx)
    ? await db<DbChatSession[]>`
        SELECT * FROM chat_sessions
        WHERE tenant_id = ${ctx.tenantId} AND user_id = ${ctx.userId}
          AND EXISTS (SELECT 1 FROM chat_messages m WHERE m.session_id = chat_sessions.id)
        ORDER BY updated_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `
    : await db<DbChatSession[]>`
        SELECT * FROM chat_sessions
        WHERE tenant_id = ${ctx.tenantId}
          AND EXISTS (SELECT 1 FROM chat_messages m WHERE m.session_id = chat_sessions.id)
        ORDER BY updated_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;

  const next_offset = offset + sessions.length < total ? offset + sessions.length : null;
  return { sessions, next_offset, total };
}

export interface ChatSearchHit {
  session: DbChatSession;
  match: "title" | "message" | "both";
  snippet: string | null;
}

export async function searchSessions(
  ctx: QueryContext,
  query: string,
  opts?: { limit?: number },
): Promise<ChatSearchHit[]> {
  const q = query.trim();
  if (!q) return [];
  const db = getDb();
  await purgeStaleEmptySessions(ctx.tenantId);
  const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 100);
  const pattern = `%${q.replace(/[%_\\]/g, "\\$&")}%`;

  // Own sessions only for members; admin sees all tenant sessions.
  const rows = shouldFilterByUser(ctx)
    ? await db<(DbChatSession & { match_title: boolean; snippet: string | null })[]>`
        SELECT DISTINCT ON (s.id)
          s.*,
          (s.title ILIKE ${pattern}) AS match_title,
          (
            SELECT left(m.content, 160)
            FROM chat_messages m
            WHERE m.session_id = s.id AND m.content ILIKE ${pattern}
            ORDER BY m.seq DESC
            LIMIT 1
          ) AS snippet
        FROM chat_sessions s
        WHERE s.tenant_id = ${ctx.tenantId}
          AND s.user_id = ${ctx.userId}
          AND EXISTS (SELECT 1 FROM chat_messages m0 WHERE m0.session_id = s.id)
          AND (
            s.title ILIKE ${pattern}
            OR EXISTS (
              SELECT 1 FROM chat_messages m
              WHERE m.session_id = s.id AND m.content ILIKE ${pattern}
            )
          )
        ORDER BY s.id, s.updated_at DESC
        LIMIT ${limit}
      `
    : await db<(DbChatSession & { match_title: boolean; snippet: string | null })[]>`
        SELECT DISTINCT ON (s.id)
          s.*,
          (s.title ILIKE ${pattern}) AS match_title,
          (
            SELECT left(m.content, 160)
            FROM chat_messages m
            WHERE m.session_id = s.id AND m.content ILIKE ${pattern}
            ORDER BY m.seq DESC
            LIMIT 1
          ) AS snippet
        FROM chat_sessions s
        WHERE s.tenant_id = ${ctx.tenantId}
          AND EXISTS (SELECT 1 FROM chat_messages m0 WHERE m0.session_id = s.id)
          AND (
            s.title ILIKE ${pattern}
            OR EXISTS (
              SELECT 1 FROM chat_messages m
              WHERE m.session_id = s.id AND m.content ILIKE ${pattern}
            )
          )
        ORDER BY s.id, s.updated_at DESC
        LIMIT ${limit}
      `;

  // Re-sort by updated_at after DISTINCT ON
  rows.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());

  return rows.map((r) => {
    const matchTitle = !!r.match_title;
    const matchMsg = r.snippet != null;
    const match: ChatSearchHit["match"] =
      matchTitle && matchMsg ? "both" : matchTitle ? "title" : "message";
    const { match_title: _mt, snippet, ...session } = r;
    return {
      session: session as DbChatSession,
      match,
      snippet: snippet ?? null,
    };
  });
}

export async function renameSession(id: string, title: string): Promise<DbChatSession | null> {
  const db = getDb();
  const trimmed = title.trim().slice(0, 200);
  if (!trimmed) return null;
  const rows = await db<DbChatSession[]>`
    UPDATE chat_sessions SET title = ${trimmed}, updated_at = now()
    WHERE id = ${id}
    RETURNING *
  `;
  return rows[0] ?? null;
}
