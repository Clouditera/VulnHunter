import { Hono } from "hono";
import { requireAuth } from "../../middleware/auth.js";
import { licenseGuard } from "../../middleware/license-guard.js";
import * as chatStorage from "./storage.js";
import { getOrCreateSession, destroySession } from "./chat-session.js";
import { logger } from "../../infra/logger.js";

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
