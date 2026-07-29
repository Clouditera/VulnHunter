/**
 * WebSocket handler for live log subscriptions.
 * Protocol:
 *   Client → Server: { type: "subscribe", task_id, since_seq?, source_filter? }
 *   Server → Client: LiveLogEvent | SnapshotEndEvent | PingEvent
 * Auth: upgrade requires session cookie; subscribe checks task ownership.
 */

import { type WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import { getEventsSince, getAllEvents } from "./event-store.js";
import { logger } from "../../infra/logger.js";
import type { SessionUser } from "../auth/types.js";
import { queryContextFromUser } from "../../infra/query-context.js";
import { getTaskById } from "../tasks/storage.js";

interface Subscription {
  ws: WebSocket;
  taskId: string;
  sourceFilter: string[] | null;
  lastSeq: number;
}

const subscriptions = new Set<Subscription>();
const PING_INTERVAL_MS = 30_000;

/** Handle a single live-log WS connection (called by ws-router after auth). */
export function handleLiveLogConnection(
  ws: WebSocket,
  req: IncomingMessage,
  user: SessionUser,
): void {
  logger.debug({ url: req.url, userId: user.userId }, "Live log WS connection");

  let sub: Subscription | null = null;
  const ctx = queryContextFromUser(user);

  const pingTimer = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "ping" }));
    }
  }, PING_INTERVAL_MS);

  ws.on("message", (data: Buffer) => {
    void (async () => {
      try {
        const msg = JSON.parse(data.toString()) as {
          type?: string;
          task_id?: string;
          since_seq?: number;
          source_filter?: string[] | null;
        };
        if (msg.type !== "subscribe") return;
        const taskId = msg.task_id;
        if (!taskId) return;

        const task = await getTaskById(ctx, taskId);
        if (!task) {
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: "error", code: "ERR_NOT_FOUND" }));
          }
          return;
        }

        if (sub) subscriptions.delete(sub);

        sub = {
          ws,
          taskId,
          sourceFilter: msg.source_filter ?? null,
          lastSeq: msg.since_seq ?? -1,
        };
        subscriptions.add(sub);

        const sinceSeq = msg.since_seq;
        const events =
          sinceSeq != null ? getEventsSince(taskId, sinceSeq) : getAllEvents(taskId);

        for (const entry of events) {
          if (matchesFilter(entry.event, sub.sourceFilter)) {
            ws.send(JSON.stringify(entry.event));
            sub.lastSeq = entry.seq;
          }
        }

        const nextSeq = events.length > 0 ? events[events.length - 1].seq + 1 : 0;
        ws.send(JSON.stringify({ type: "snapshot_end", next_seq: nextSeq }));
      } catch (err) {
        logger.debug({ err }, "WS message parse error");
      }
    })();
  });

  ws.on("close", () => {
    clearInterval(pingTimer);
    if (sub) subscriptions.delete(sub);
  });

  ws.on("error", (err) => {
    logger.warn({ err }, "Live log WS error");
  });
}

/** @deprecated Use handleLiveLogConnection + ws-router instead */
export function createLiveLogWss(_server: import("node:http").Server): void {
  // No-op — kept for backward compat, ws-router handles upgrade now
}

function matchesFilter(event: { source?: string }, filter: string[] | null): boolean {
  if (!filter || filter.length === 0) return true;
  const src = (event as { source?: string }).source ?? "";
  return filter.includes(src);
}

/** Push new event to all subscribed clients */
export function broadcastEvent(taskId: string, seq: number, event: object): void {
  for (const sub of subscriptions) {
    if (sub.taskId !== taskId) continue;
    if (sub.ws.readyState !== sub.ws.OPEN) continue;
    if (!matchesFilter(event as { source?: string }, sub.sourceFilter)) continue;
    if (seq <= sub.lastSeq) continue;

    sub.ws.send(JSON.stringify(event));
    sub.lastSeq = seq;
  }
}
