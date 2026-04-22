/**
 * Bridge Proxy — session-level singleton WS to bridge + fan-out to N frontend clients.
 *
 * Key invariant: service→bridge WS is created ONCE per session by routes.ts
 * (via connectBridgeProxy), NOT by frontend WS connections. Frontend clients
 * subscribe/unsubscribe without affecting the bridge WS lifecycle.
 */

import { WebSocket } from "ws";
import { appendMessage } from "./storage.js";
import { logger } from "../../infra/logger.js";

const EVENT_BUFFER_SIZE = 100;

interface SessionProxy {
  sessionId: string;
  bridgeWs: WebSocket | null;
  clients: Set<WebSocket>;           // frontend WS subscribers
  eventBuffer: string[];             // last N serialized events for replay
  readyResolve: () => void;
  readyReject: (err: Error) => void;
  readyPromise: Promise<void>;
  connected: boolean;
  // Assistant message assembly (for DB persistence)
  currentAssistantContent: string;
  currentToolCalls: unknown[];
}

const proxies = new Map<string, SessionProxy>();

function createProxy(sessionId: string): SessionProxy {
  let readyResolve!: () => void;
  let readyReject!: (err: Error) => void;
  const readyPromise = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  const proxy: SessionProxy = {
    sessionId,
    bridgeWs: null,
    clients: new Set(),
    eventBuffer: [],
    readyResolve,
    readyReject,
    readyPromise,
    connected: false,
    currentAssistantContent: "",
    currentToolCalls: [],
  };
  proxies.set(sessionId, proxy);
  return proxy;
}

/**
 * Connect service→bridge WS for a session. Called by routes.ts AFTER ensureWorker.
 * Returns when WS handshake completes. Reuses existing connection if alive.
 */
export async function connectBridgeProxy(
  sessionId: string,
  bridgeUrl: string,
  timeoutMs = 10000,
): Promise<void> {
  let proxy = proxies.get(sessionId);

  // Already connected — return immediately
  if (proxy?.connected && proxy.bridgeWs?.readyState === WebSocket.OPEN) {
    return;
  }

  // Clean up stale proxy if bridge WS is dead
  if (proxy && !proxy.connected) {
    // Reuse proxy (keep clients + eventBuffer), just reconnect bridge WS
  } else if (!proxy) {
    proxy = createProxy(sessionId);
  }

  const wsUrl = bridgeUrl.replace("http://", "ws://") + "/chat/events";
  logger.debug({ sessionId, wsUrl }, "Bridge proxy connecting");

  const ws = new WebSocket(wsUrl);

  ws.on("open", () => {
    proxy!.bridgeWs = ws;
    proxy!.connected = true;
    proxy!.readyResolve();
    logger.info({ sessionId }, "Bridge proxy connected");
  });

  ws.on("message", (data: Buffer) => {
    const line = data.toString();
    handleBridgeEvent(proxy!, line);
  });

  ws.on("close", () => {
    if (proxy!.bridgeWs === ws) {
      proxy!.bridgeWs = null;
      proxy!.connected = false;
    }
    logger.debug({ sessionId }, "Bridge proxy WS closed");
  });

  ws.on("error", (err) => {
    logger.debug({ sessionId, err: err.message }, "Bridge proxy WS error");
    if (proxy!.bridgeWs === ws) {
      proxy!.bridgeWs = null;
      proxy!.connected = false;
    }
  });

  // Wait for open with timeout
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Bridge WS not ready after ${timeoutMs}ms`)), timeoutMs),
  );

  await Promise.race([proxy.readyPromise, timeout]);
}

/** Handle a single event from bridge — persist, buffer, fan-out */
function handleBridgeEvent(proxy: SessionProxy, line: string): void {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line);
  } catch {
    // Non-JSON line — forward raw
    broadcastToClients(proxy, line);
    return;
  }

  // Track assistant content for DB persistence
  if (event.type === "message_start" && (event.message as Record<string, unknown>)?.role === "assistant") {
    proxy.currentAssistantContent = "";
    proxy.currentToolCalls = [];
  }

  if (event.type === "message_update") {
    const ame = event.assistantMessageEvent as Record<string, unknown> | undefined;
    const partial = ame?.partial as Record<string, unknown> | undefined;
    if (partial?.role === "assistant" && Array.isArray(partial.content)) {
      for (const block of partial.content as Array<{ type: string; text?: string }>) {
        if (block.type === "text" && typeof block.text === "string") {
          proxy.currentAssistantContent = block.text;
        }
      }
    }
  }

  if (event.type === "message_end" && (event.message as Record<string, unknown>)?.role === "assistant") {
    const content = (event.message as Record<string, unknown>).content;
    if (Array.isArray(content)) {
      for (const block of content as Array<{ type: string; text?: string }>) {
        if (block.type === "text") proxy.currentAssistantContent = block.text ?? "";
      }
    }
    // Persist assistant message to DB
    if (proxy.currentAssistantContent) {
      appendMessage({
        sessionId: proxy.sessionId,
        role: "assistant",
        content: proxy.currentAssistantContent,
        toolCalls: proxy.currentToolCalls.length > 0 ? proxy.currentToolCalls : undefined,
      }).catch((err) => logger.warn({ err }, "Failed to persist assistant message"));
    }
  }

  if (event.type === "tool_execution_end") {
    proxy.currentToolCalls.push({
      tool: event.name ?? event.tool,
      args: event.args_summary ?? "",
      result: event.result_summary ?? "",
    });
  }

  // Serialize with session_id envelope
  const serialized = JSON.stringify({ session_id: proxy.sessionId, ...event });

  // Buffer for late-joining clients
  proxy.eventBuffer.push(serialized);
  if (proxy.eventBuffer.length > EVENT_BUFFER_SIZE) {
    proxy.eventBuffer.shift();
  }

  // Fan-out to all subscribed frontend clients
  broadcastToClients(proxy, serialized);
}

function broadcastToClients(proxy: SessionProxy, data: string): void {
  for (const client of proxy.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

/**
 * Subscribe a frontend WS client to a session's event stream.
 * Replays buffered events so late-joining clients don't miss anything.
 */
export function subscribeFrontendClient(sessionId: string, clientWs: WebSocket): void {
  let proxy = proxies.get(sessionId);
  if (!proxy) {
    proxy = createProxy(sessionId);
  }

  proxy.clients.add(clientWs);
  logger.debug({ sessionId, clientCount: proxy.clients.size }, "Frontend client subscribed");

  // Replay buffered events for this client
  for (const event of proxy.eventBuffer) {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(event);
    }
  }

  function cleanup(): void {
    proxy!.clients.delete(clientWs);
    logger.debug({ sessionId, clientCount: proxy!.clients.size }, "Frontend client unsubscribed");
  }

  clientWs.on("close", cleanup);
  clientWs.on("error", cleanup);
}

/**
 * Disconnect bridge proxy for a session (called on session delete).
 */
export function disconnectBridgeProxy(sessionId: string): void {
  const proxy = proxies.get(sessionId);
  if (!proxy) return;

  if (proxy.bridgeWs) {
    proxy.bridgeWs.close();
  }
  for (const client of proxy.clients) {
    client.close();
  }
  proxies.delete(sessionId);
  logger.debug({ sessionId }, "Bridge proxy disconnected");
}
