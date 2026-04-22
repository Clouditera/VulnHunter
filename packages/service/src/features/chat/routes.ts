import { Hono } from "hono";
import { requireAuth } from "../../middleware/auth.js";
import { licenseGuard } from "../../middleware/license-guard.js";
import * as chatStorage from "./storage.js";
import { ensureWorker, stopWorker, getWorkerUrl } from "./worker-manager.js";
import { connectBridgeProxy, disconnectBridgeProxy } from "./bridge-proxy.js";
import { loadConfig } from "../../infra/config.js";
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
  const body = await c.req.json<{ name?: string }>().catch(() => ({} as { name?: string }));
  const session = await chatStorage.createSession(user.userId, body.name);  // name maps to title in DB
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
  disconnectBridgeProxy(id);
  await stopWorker(id);
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

  const config = loadConfig();

  // Save user message to DB
  await chatStorage.appendMessage({
    sessionId,
    role: "user",
    content: body.message,
  });
  await chatStorage.updateSessionTimestamp(sessionId);

  // Ensure worker is running
  let bridgeUrl: string;
  try {
    bridgeUrl = await ensureWorker(sessionId, config);
  } catch (err) {
    logger.error({ err, sessionId }, "Failed to start chat worker");
    return c.json({ error: { code: "ERR_INTERNAL", detail: String(err) } }, 503);
  }

  // Proactively connect service→bridge WS (session-level singleton).
  // This MUST succeed before forwarding the prompt, otherwise events will be lost.
  try {
    await connectBridgeProxy(sessionId, bridgeUrl, 10000);
  } catch (err) {
    logger.error({ err, sessionId }, "Failed to connect bridge WS proxy");
    return c.json({ error: { code: "ERR_INTERNAL", detail: "Bridge WS not ready" } }, 503);
  }

  // Forward prompt to bridge
  try {
    const res = await fetch(`${bridgeUrl}/chat/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: body.message, images: body.images }),
      signal: AbortSignal.timeout(10000),
    });
    const result = await res.json() as { ok: boolean };
    return c.json({ ok: result.ok });
  } catch (err) {
    logger.error({ err, sessionId }, "Failed to forward prompt to bridge");
    return c.json({ error: { code: "ERR_INTERNAL", detail: "Bridge unreachable" } }, 503);
  }
});

// POST /api/chat/sessions/:id/abort
chatRouter.post("/sessions/:id/abort", async (c) => {
  const sessionId = c.req.param("id");
  const config = loadConfig();
  const bridgeUrl = getWorkerUrl(sessionId, config);

  if (!bridgeUrl) {
    return c.json({ ok: true }); // No worker running, nothing to abort
  }

  try {
    await fetch(`${bridgeUrl}/chat/abort`, { method: "POST", signal: AbortSignal.timeout(5000) });
  } catch { /* best effort */ }

  return c.json({ ok: true });
});
