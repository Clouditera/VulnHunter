import { Hono } from "hono";
import { requireAuth } from "../../middleware/auth.js";
import { licenseGuard } from "../../middleware/license-guard.js";
import * as chatStorage from "./storage.js";
import { getOrCreateSession, destroySession } from "./chat-session.js";
import { logger } from "../../infra/logger.js";
import { loadConfig } from "../../infra/config.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, extname } from "node:path";
import { createHash } from "node:crypto";

export const chatRouter = new Hono();
chatRouter.use("*", licenseGuard);
chatRouter.use("*", requireAuth);

// GET /api/chat/sessions
chatRouter.get("/sessions", async (c) => {
  const user = c.get("user");
  const sessions = await chatStorage.listSessions(user.userId);
  return c.json({ sessions });
});

// POST /api/chat/sessions — create new session
chatRouter.post("/sessions", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ name?: string; credential_id?: string }>().catch(() => ({} as { name?: string; credential_id?: string }));
  const session = await chatStorage.createSession(user.userId, body.name, body.credential_id);
  return c.json({ session }, 201);
});

// GET /api/chat/sessions/:id
chatRouter.get("/sessions/:id", async (c) => {
  const session = await chatStorage.getSession(c.req.param("id"));
  if (!session) return c.json({ error: { code: "ERR_NOT_FOUND" } }, 404);
  return c.json({ session });
});

// DELETE /api/chat/sessions/:id
chatRouter.delete("/sessions/:id", async (c) => {
  const id = c.req.param("id");
  await destroySession(id);
  await chatStorage.deleteSession(id);
  return c.json({ ok: true });
});

// GET /api/chat/sessions/:id/messages
chatRouter.get("/sessions/:id/messages", async (c) => {
  const sinceSeq = c.req.query("since_seq");
  const messages = await chatStorage.listMessages(
    c.req.param("id"),
    sinceSeq ? Number(sinceSeq) : undefined,
  );
  return c.json({ messages });
});

// POST /api/chat/sessions/:id/prompt — send message
chatRouter.post("/sessions/:id/prompt", async (c) => {
  const sessionId = c.req.param("id");
  const session = await chatStorage.getSession(sessionId);
  if (!session) return c.json({ error: { code: "ERR_NOT_FOUND" } }, 404);

  const body = await c.req.json<{ message: string; images?: unknown[] }>();
  if (!body.message?.trim()) {
    return c.json({ error: { code: "ERR_INTERNAL", detail: "message required" } }, 400);
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
    return c.json({ error: { code: "ERR_INTERNAL", detail: String(err) } }, 503);
  }
});

// POST /api/chat/sessions/:id/abort
chatRouter.post("/sessions/:id/abort", async (c) => {
  const sessionId = c.req.param("id");
  const session = getOrCreateSession(sessionId);
  await session.abort();
  return c.json({ ok: true });
});

// POST /api/chat/sessions/:id/set-model — runtime model switching
chatRouter.post("/sessions/:id/set-model", async (c) => {
  const sessionId = c.req.param("id");
  const dbSession = await chatStorage.getSession(sessionId);
  if (!dbSession) return c.json({ error: { code: "ERR_NOT_FOUND" } }, 404);

  const body = await c.req.json<{ credential_id: string }>();
  if (!body.credential_id) {
    return c.json({ error: { code: "ERR_INTERNAL", detail: "credential_id required" } }, 400);
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
  const sessionId = c.req.param("id");
  const session = await chatStorage.getSession(sessionId);
  if (!session) return c.json({ error: { code: "ERR_NOT_FOUND" } }, 404);

  const body = await c.req.parseBody();
  const file = body["file"];
  if (!file || typeof file === "string") {
    return c.json({ error: { code: "ERR_INTERNAL", detail: "file field required" } }, 400);
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  if (buffer.length === 0) {
    return c.json({ error: { code: "ERR_INTERNAL", detail: "Empty file" } }, 400);
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
