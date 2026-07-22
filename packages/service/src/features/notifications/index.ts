/**
 * Global SSE notification channel — pushes discrete state-change events to frontend.
 * Replaces polling (refetchInterval) for task state, findings indexed, chat worker state.
 *
 * Endpoint: GET /api/notifications (SSE stream)
 */

import { Hono } from "hono";
import { stream } from "hono/streaming";
import { requireAuth } from "../../middleware/auth.js";
import { licenseGuard } from "../../middleware/license-guard.js";
import { logger } from "../../infra/logger.js";
import { getDb } from "../../infra/db/client.js";
import type { TaskState, FindingReviewStatus } from "@vulnhunter/shared";

// ─── Event types ───

export type NotificationEvent =
  | { type: "task_state"; taskId: string; state: TaskState; prevState?: string; ownerId?: string | null }
  | { type: "findings_indexed"; taskId: string; count: number; ownerId?: string | null }
  | { type: "chat_worker_state"; sessionId: string; state: string; ownerId?: string | null }
  | { type: "chat_session_title"; sessionId: string; title: string; ownerId?: string | null }
  | { type: "chat_artifact_created"; sessionId: string; artifactId: string; ownerId?: string | null }
  | { type: "finding_review_updated"; taskId: string; findingKeys: string[]; reviewStatus: FindingReviewStatus; ownerId?: string | null };

// ─── In-memory subscriber list ───

interface Subscriber {
  id: string;
  userId: string;
  role: "admin" | "member";
  write: (data: string) => void;
  close: () => void;
}

const subscribers = new Set<Subscriber>();

/**
 * Broadcast a notification to all connected SSE clients.
 * Call this from anywhere in the service (scheduler, chat-session, etc.)
 */
export function notify(event: NotificationEvent): void {
  if (subscribers.size === 0) return;
  void resolveOwnerId(event).then((ownerId) => broadcast({ ...event, ownerId } as NotificationEvent));
}

function broadcast(event: NotificationEvent): void {
  const data = JSON.stringify(event);
  const payload = `data: ${data}\n\n`;
  const ownerId = "ownerId" in event ? event.ownerId : undefined;
  for (const sub of subscribers) {
    if (ownerId && sub.role !== "admin" && sub.userId !== ownerId) continue;
    try {
      sub.write(payload);
    } catch {
      subscribers.delete(sub);
    }
  }
}

async function resolveOwnerId(event: NotificationEvent): Promise<string | null | undefined> {
  if ("ownerId" in event && event.ownerId !== undefined) return event.ownerId;
  const db = getDb();
  if ("taskId" in event) {
    const rows = await db<{ created_by: string | null }[]>`SELECT created_by FROM tasks WHERE id = ${event.taskId} LIMIT 1`;
    return rows[0]?.created_by ?? null;
  }
  if ("sessionId" in event) {
    const rows = await db<{ user_id: string | null }[]>`SELECT user_id FROM chat_sessions WHERE id = ${event.sessionId} LIMIT 1`;
    return rows[0]?.user_id ?? null;
  }
  return undefined;
}

// ─── Hono router ───

export const notificationRouter = new Hono();
notificationRouter.use("*", async (c, next) => {
  if (c.req.path === "/api/system/activate") return next();
  return licenseGuard(c, next);
});
notificationRouter.use("*", async (c, next) => {
  if (c.req.path === "/api/system/activate") return next();
  return requireAuth(c, next);
});

notificationRouter.get("/notifications", (c) => {
  const subId = `sse-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const user = c.get("user");

  return stream(c, async (s) => {
    // Set SSE headers
    c.header("Content-Type", "text/event-stream");
    c.header("Cache-Control", "no-cache");
    c.header("Connection", "keep-alive");

    const sub: Subscriber = {
      id: subId,
      userId: user.userId,
      role: user.role === "admin" ? "admin" : "member",
      write: (data: string) => {
        s.write(data).catch(() => {});
      },
      close: () => {
        subscribers.delete(sub);
      },
    };

    subscribers.add(sub);
    logger.debug({ subId, count: subscribers.size }, "SSE client connected");

    // Send initial heartbeat
    await s.write(": connected\n\n");

    // Keep alive with periodic heartbeat
    const heartbeat = setInterval(() => {
      s.write(": heartbeat\n\n").catch(() => {
        clearInterval(heartbeat);
        subscribers.delete(sub);
      });
    }, 30000);

    // Cleanup on disconnect
    s.onAbort(() => {
      clearInterval(heartbeat);
      subscribers.delete(sub);
      logger.debug({ subId, count: subscribers.size }, "SSE client disconnected");
    });

    // Keep the stream open indefinitely — events are pushed via notify()
    // The stream will close when the client disconnects (onAbort fires)
    await new Promise(() => {}); // never resolves — stream stays open
  });
});
