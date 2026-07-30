import { Hono } from "hono";
import { requireAuth } from "../../middleware/auth.js";
import { licenseGuard } from "../../middleware/license-guard.js";
import * as chatStorage from "./storage.js";
import { getOrCreateSession, destroySession } from "./chat-session.js";
import { logger } from "../../infra/logger.js";
import { loadConfig } from "../../infra/config.js";
import { isTextualMime, withUtf8Charset } from "../../infra/http-text.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, extname, basename } from "node:path";
import { createHash } from "node:crypto";
import { isPreviewableMime, readMinioPreview } from "./artifact-preview.js";
import { getCredentialById, getDefaultOrFirstAvailableCredential } from "../settings/storage.js";
import { ChatCredentialUnavailableError } from "./errors.js";
import { CredentialDecryptError, CredentialKeyUnavailableError } from "../../infra/crypto/master-key-vault.js";
import { queryContextFromUser } from "../../infra/query-context.js";
import { listUsersByIds } from "../auth/storage.js";
import { attachCreatorSummaries, uniqueCreatorIds } from "../auth/creator-summary.js";

export const chatRouter = new Hono();
chatRouter.use("*", licenseGuard);
chatRouter.use("*", requireAuth);

async function getOwnedSession(c: any) {
  const ctx = queryContextFromUser(c.get("user"));
  return chatStorage.getSessionForContext(c.req.param("id"), ctx);
}

// GET /api/chat/sessions — supports ?limit=&offset= for infinite scroll (default 20)
chatRouter.get("/sessions", async (c) => {
  const ctx = queryContextFromUser(c.get("user"));
  const hasPaging = c.req.query("limit") != null || c.req.query("offset") != null;
  if (hasPaging) {
    const limit = Number(c.req.query("limit") ?? 20);
    const offset = Number(c.req.query("offset") ?? 0);
    const page = await chatStorage.listSessionsPage(ctx, { limit, offset });
    let sessions = page.sessions;
    if (ctx.role === "admin") {
      const creators = await listUsersByIds(uniqueCreatorIds(sessions, "user_id"));
      sessions = attachCreatorSummaries(ctx.role, sessions, "user_id", creators) as typeof sessions;
    }
    return c.json({ sessions, next_offset: page.next_offset, total: page.total });
  }
  // Backward-compatible unpaged list (legacy clients)
  const sessions = await chatStorage.listSessions(ctx);
  if (ctx.role !== "admin") return c.json({ sessions });
  const creators = await listUsersByIds(uniqueCreatorIds(sessions, "user_id"));
  return c.json({ sessions: attachCreatorSummaries(ctx.role, sessions, "user_id", creators) });
});

// GET /api/chat/sessions/search?q=
chatRouter.get("/sessions/search", async (c) => {
  const ctx = queryContextFromUser(c.get("user"));
  const q = (c.req.query("q") ?? "").trim();
  if (!q) return c.json({ query: q, results: [], groups: emptySearchGroups() });
  if (q.length > 200) {
    return c.json({ error: { code: "ERR_VALIDATION", message: "query too long" } }, 400);
  }
  const hits = await chatStorage.searchSessions(ctx, q, { limit: 50 });
  const results = hits.map((h) => ({
    session: h.session,
    match: h.match,
    snippet: h.snippet,
  }));
  return c.json({ query: q, results, groups: groupSearchByDate(results.map((r) => r.session)) });
});

function emptySearchGroups(): {
  today: chatStorage.DbChatSession[];
  yesterday: chatStorage.DbChatSession[];
  last_7_days: chatStorage.DbChatSession[];
  this_year: chatStorage.DbChatSession[];
  earlier: chatStorage.DbChatSession[];
} {
  return { today: [], yesterday: [], last_7_days: [], this_year: [], earlier: [] };
}

function groupSearchByDate(sessions: chatStorage.DbChatSession[]) {
  const groups = emptySearchGroups();
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfYesterday = new Date(startOfToday.getTime() - 86400000);
  const startOf7 = new Date(startOfToday.getTime() - 6 * 86400000);
  const startOfYear = new Date(now.getFullYear(), 0, 1);
  for (const s of sessions) {
    const t = new Date(s.updated_at).getTime();
    if (t >= startOfToday.getTime()) groups.today.push(s);
    else if (t >= startOfYesterday.getTime()) groups.yesterday.push(s);
    else if (t >= startOf7.getTime()) groups.last_7_days.push(s);
    else if (t >= startOfYear.getTime()) groups.this_year.push(s);
    else groups.earlier.push(s);
  }
  return groups;
}

// POST /api/chat/sessions — create new session
chatRouter.post("/sessions", async (c) => {
  const user = c.get("user");
  const ctx = queryContextFromUser(user);
  const body = await c.req.json<{ name?: string; credential_id?: string }>().catch(() => ({} as { name?: string; credential_id?: string }));
  let credentialId: string | undefined;
  try {
    if (body.credential_id) {
      const credential = await getCredentialById(ctx, body.credential_id);
      if (!credential) {
        return c.json({ error: { code: "ERR_NO_LLM_CREDENTIAL", detail: "选择的模型凭证不可用。请重新选择模型，或在 Settings 重新配置后重试。" } }, 409);
      }
      credentialId = credential.id;
    } else {
      const credential = await getDefaultOrFirstAvailableCredential(ctx);
      credentialId = credential?.id;
    }
  } catch (err) {
    if (err instanceof CredentialKeyUnavailableError || err instanceof CredentialDecryptError) {
      credentialId = undefined;
    } else {
      throw err;
    }
  }
  const session = await chatStorage.createSession(user.userId, body.name, credentialId, ctx.tenantId);
  return c.json({ session }, 201);
});

// GET /api/chat/sessions/:id
chatRouter.get("/sessions/:id", async (c) => {
  const session = await getOwnedSession(c);
  if (!session) return c.json({ error: { code: "ERR_NOT_FOUND" } }, 404);
  return c.json({ session });
});

// DELETE /api/chat/sessions/:id
chatRouter.delete("/sessions/:id", async (c) => {
  const session = await getOwnedSession(c);
  if (!session) return c.json({ error: { code: "ERR_NOT_FOUND" } }, 404);
  await destroySession(session.id);
  await chatStorage.deleteSession(session.id);
  return c.json({ ok: true });
});

// PATCH /api/chat/sessions/:id — rename
chatRouter.patch("/sessions/:id", async (c) => {
  const session = await getOwnedSession(c);
  if (!session) return c.json({ error: { code: "ERR_NOT_FOUND" } }, 404);
  const body = await c.req.json<{ title?: string }>();
  const title = (body.title ?? "").trim();
  if (!title) return c.json({ error: { code: "ERR_VALIDATION", message: "title required" } }, 400);
  const updated = await chatStorage.renameSession(session.id, title);
  return c.json({ session: updated });
});

// GET /api/chat/sessions/:id/messages
chatRouter.get("/sessions/:id/messages", async (c) => {
  const session = await getOwnedSession(c);
  if (!session) return c.json({ error: { code: "ERR_NOT_FOUND" } }, 404);
  const sinceSeq = c.req.query("since_seq");
  const messages = await chatStorage.listMessages(
    session.id,
    sinceSeq ? Number(sinceSeq) : undefined,
  );
  return c.json({ messages });
});

// POST /api/chat/sessions/:id/prompt — send message
chatRouter.post("/sessions/:id/prompt", async (c) => {
  const session = await getOwnedSession(c);
  if (!session) return c.json({ error: { code: "ERR_NOT_FOUND" } }, 404);
  const sessionId = session.id;

  const body = await c.req.json<{ message: string; images?: unknown[] }>();
  if (!body.message?.trim()) {
    return c.json({ error: { code: "ERR_BAD_REQUEST", detail: "message required" } }, 400);
  }

  // Save user message to DB
  await chatStorage.appendMessage({
    sessionId,
    role: "user",
    content: body.message,
  });
  await chatStorage.updateSessionTimestamp(sessionId);

  // ChatSession handles all lifecycle: container spawn + WS connect + prompt forward
  try {
    const session = getOrCreateSession(sessionId);
    await session.sendPrompt(body.message, body.images);
    return c.json({ ok: true });
  } catch (err) {
    logger.error({ err, sessionId }, "Failed to send prompt");
    if (err instanceof ChatCredentialUnavailableError) {
      return c.json({ error: { code: err.code, detail: err.message } }, 409);
    }
    return c.json({ error: { code: "ERR_INTERNAL", detail: String(err) } }, 503);
  }
});

// POST /api/chat/sessions/:id/abort
chatRouter.post("/sessions/:id/abort", async (c) => {
  const dbSession = await getOwnedSession(c);
  if (!dbSession) return c.json({ error: { code: "ERR_NOT_FOUND" } }, 404);
  const session = getOrCreateSession(dbSession.id);
  await session.abort();
  return c.json({ ok: true });
});

// POST /api/chat/sessions/:id/set-model — runtime model switching
chatRouter.post("/sessions/:id/set-model", async (c) => {
  const dbSession = await getOwnedSession(c);
  if (!dbSession) return c.json({ error: { code: "ERR_NOT_FOUND" } }, 404);
  const sessionId = dbSession.id;

  const body = await c.req.json<{ credential_id: string }>();
  if (!body.credential_id) {
    return c.json({ error: { code: "ERR_BAD_REQUEST", detail: "credential_id required" } }, 400);
  }

  try {
    const session = getOrCreateSession(sessionId);
    await session.setModel(body.credential_id);

    // Update DB so next container spawn uses the new credential
    await chatStorage.updateSessionCredential(sessionId, body.credential_id);

    return c.json({ ok: true });
  } catch (err) {
    logger.error({ err, sessionId }, "Failed to set model");
    return c.json({ error: { code: "ERR_INTERNAL", detail: String(err) } }, 503);
  }
});

// POST /api/chat/sessions/:id/upload — file attachment upload (any file type, up to 500MB)
chatRouter.post("/sessions/:id/upload", async (c) => {
  const session = await getOwnedSession(c);
  if (!session) return c.json({ error: { code: "ERR_NOT_FOUND" } }, 404);
  const sessionId = session.id;

  const body = await c.req.parseBody();
  const file = body["file"];
  if (!file || typeof file === "string") {
    return c.json({ error: { code: "ERR_BAD_REQUEST", detail: "file field required" } }, 400);
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  if (buffer.length === 0) {
    return c.json({ error: { code: "ERR_BAD_REQUEST", detail: "Empty file" } }, 400);
  }
  if (buffer.length > 500 * 1024 * 1024) {
    return c.json({ error: { code: "ERR_INTERNAL", detail: "File too large (max 500MB)" } }, 413);
  }

  // Hash-based filename to avoid collisions
  const hash = createHash("sha256").update(buffer).digest("hex").slice(0, 12);
  const ext = extname(file.name || ".bin") || ".bin";
  const storedName = `${hash}${ext}`;

  // Store in session workspace — bind mount makes it visible inside container
  const config = loadConfig();
  const attachDir = join(config.dataDir, "chat-sessions", sessionId, "attachments");
  mkdirSync(attachDir, { recursive: true });
  writeFileSync(join(attachDir, storedName), buffer);

  // Also upload to MinIO for durable reference
  const { getMinio } = await import("../../infra/minio/client.js");
  const minio = getMinio();
  const minioKey = `chat-artifacts/${sessionId}/${storedName}`;
  await minio.putObject(config.minio.bucket, minioKey, buffer);

  // Create artifact record
  const { getDb } = await import("../../infra/db/client.js");
  const db = getDb();
  const [artifact] = await db<{ id: string }[]>`
    INSERT INTO chat_artifacts (tenant_id, session_id, user_id, kind, original_name, filename, mime_type, size_bytes, minio_key, workspace_path)
    VALUES (${session.tenant_id}, ${sessionId}, ${session.user_id}, 'upload', ${file.name || storedName}, ${storedName}, ${file.type || "application/octet-stream"}, ${buffer.length}, ${minioKey}, ${`/workspace/attachments/${storedName}`})
    RETURNING id
  `;

  const containerPath = `/workspace/attachments/${storedName}`;

  logger.info({ sessionId, artifactId: artifact.id, originalName: file.name, storedName, size: buffer.length }, "Chat attachment uploaded");

  return c.json({
    artifact_id: artifact.id,
    path: containerPath,
    originalName: file.name || storedName,
    filename: storedName,
    mimeType: file.type || "application/octet-stream",
    size: buffer.length,
  });
});

// GET /api/chat/sessions/:id/artifacts — durable presented artifacts for this session
chatRouter.get("/sessions/:id/artifacts", async (c) => {
  const session = await getOwnedSession(c);
  if (!session) return c.json({ error: { code: "ERR_NOT_FOUND" } }, 404);

  const { getDb } = await import("../../infra/db/client.js");
  const db = getDb();
  const artifacts = await db`
    SELECT id, title, original_name, filename, mime_type, size_bytes, minio_key, workspace_path, metadata, created_at
    FROM chat_artifacts
    WHERE session_id = ${session.id}
      AND user_id = ${session.user_id}
      AND tenant_id = ${session.tenant_id}
      AND kind = 'presented'
    ORDER BY created_at DESC
  `;

  const config = loadConfig();
  const { getMinio } = await import("../../infra/minio/client.js");
  const minio = getMinio();
  const withPreview = await Promise.all(artifacts.map(async (a: any) => {
    const meta = a.metadata ?? {};
    let preview: string | undefined = typeof meta.preview === "string" ? meta.preview : undefined;
    let preview_status = typeof meta.preview_status === "string" ? meta.preview_status : undefined;
    let preview_truncated = Boolean(meta.preview_truncated);
    if (!preview_status) {
      if (preview) {
        preview_status = "ready";
      } else if (isPreviewableMime(a.mime_type)) {
        const result = await readMinioPreview(minio, config.minio.bucket, a.minio_key, a.mime_type);
        preview = result.preview;
        preview_status = result.preview_status;
        preview_truncated = result.preview_truncated;
      } else {
        preview_status = "unsupported";
      }
    }
    const metaSource =
      meta && typeof meta === "object" && typeof (meta as { source_path?: unknown }).source_path === "string"
        ? String((meta as { source_path: string }).source_path)
        : undefined;
    return {
      artifact_id: a.id,
      title: a.title ?? a.original_name,
      filename: a.filename,
      original_name: a.original_name,
      mime_type: a.mime_type,
      size_bytes: Number(a.size_bytes ?? 0),
      preview,
      preview_status,
      preview_truncated,
      download_url: `/api/chat/sessions/${session.id}/artifacts/${a.id}/download`,
      created_at: a.created_at,
      workspace_path: a.workspace_path ?? metaSource ?? null,
    };
  }));

  return c.json({ artifacts: withPreview });
});

// GET /api/chat/sessions/:id/artifacts/:artifactId/download — authenticated artifact download
chatRouter.get("/sessions/:id/artifacts/:artifactId/download", async (c) => {
  const session = await getOwnedSession(c);
  if (!session) return c.json({ error: { code: "ERR_NOT_FOUND" } }, 404);

  const { getDb } = await import("../../infra/db/client.js");
  const db = getDb();
  const rows = await db<any[]>`
    SELECT id, filename, mime_type, minio_key
    FROM chat_artifacts
    WHERE id = ${c.req.param("artifactId")}
      AND session_id = ${session.id}
      AND user_id = ${session.user_id}
      AND tenant_id = ${session.tenant_id}
      AND kind = 'presented'
    LIMIT 1
  `;
  const artifact = rows[0];
  if (!artifact) return c.json({ error: { code: "ERR_NOT_FOUND" } }, 404);

  try {
    const config = loadConfig();
    const { getMinio } = await import("../../infra/minio/client.js");
    const stream = await getMinio().getObject(config.minio.bucket, artifact.minio_key);
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", resolve);
      stream.on("error", reject);
    });
    const filename = basename(artifact.filename || "artifact").replace(/["\\]/g, "_");
    const buf = Buffer.concat(chunks);
    const mime = artifact.mime_type || "application/octet-stream";
    const contentType = isTextualMime(mime) ? withUtf8Charset(mime) : mime;
    return new Response(buf, {
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${filename}"`,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    logger.error({ err, artifactId: artifact.id }, "Failed to download chat artifact");
    return c.json({ error: { code: "ERR_NOT_FOUND" } }, 404);
  }
});
