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
import type { TaskState, FindingReviewStatus } from "@vulnagent/shared";

// ─── Event types ───

export type NotificationEvent =
  | { type: "task_state"; taskId: string; state: TaskState; prevState?: string }
  | { type: "findings_indexed"; taskId: string; count: number }
  | { type: "chat_worker_state"; sessionId: string; state: string }
  | { type: "chat_session_title"; sessionId: string; title: string }
  | { type: "chat_artifact_created"; sessionId: string; artifactId: string }
  | { type: "finding_review_updated"; taskId: string; findingKeys: string[]; reviewStatus: FindingReviewStatus };

// ─── In-memory subscriber list ───

interface Subscriber {
  id: string;
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
  const data = JSON.stringify(event);
  const payload = `data: ${data}\n\n`;
  for (const sub of subscribers) {
    try {
      sub.write(payload);
    } catch {
      subscribers.delete(sub);
    }
  }
}

// ─── Hono router ───

export const notificationRouter = new Hono();
notificationRouter.use("*", licenseGuard);
notificationRouter.use("*", requireAuth);

notificationRouter.get("/notifications", (c) => {
  const subId = `sse-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  return stream(c, async (s) => {
    // Set SSE headers
    c.header("Content-Type", "text/event-stream");
    c.header("Cache-Control", "no-cache");
    c.header("Connection", "keep-alive");

    const sub: Subscriber = {
      id: subId,
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
