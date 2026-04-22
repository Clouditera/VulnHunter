/**
 * WS proxy for chat events.
 * Frontend connects to /ws/chat/:sessionId → service proxies to bridge WS.
 */

import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";
import { getWorkerUrl } from "./worker-manager.js";
import { appendMessage } from "./storage.js";
import { loadConfig } from "../../infra/config.js";
import { logger } from "../../infra/logger.js";

// Track bridge WS readiness per session so routes.ts can await before forwarding prompts
interface BridgeReady {
  resolve: () => void;
  promise: Promise<void>;
  connected: boolean;
}
const bridgeReadyMap = new Map<string, BridgeReady>();

function getOrCreateBridgeReady(sessionId: string): BridgeReady {
  let entry = bridgeReadyMap.get(sessionId);
  if (!entry) {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => { resolve = r; });
    entry = { resolve, promise, connected: false };
    bridgeReadyMap.set(sessionId, entry);
  }
  return entry;
}

function markBridgeReady(sessionId: string): void {
  const entry = getOrCreateBridgeReady(sessionId);
  if (!entry.connected) {
    entry.connected = true;
    entry.resolve();
  }
}

function resetBridgeReady(sessionId: string): void {
  bridgeReadyMap.delete(sessionId);
}

/**
 * Wait for bridge WS connection to be established for a session.
 * Used by routes.ts to ensure events won't be lost before forwarding prompt.
 */
export async function waitForBridgeWs(sessionId: string, timeoutMs = 8000): Promise<void> {
  const entry = getOrCreateBridgeReady(sessionId);
  if (entry.connected) return;

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Bridge WS not ready after ${timeoutMs}ms`)), timeoutMs),
  );
  await Promise.race([entry.promise, timeout]);
}

export function createChatWss(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: /^\/ws\/chat\/[a-f0-9-]+$/ as unknown as string });

  // WebSocketServer with regex path doesn't work. Use noServer mode instead.
  return wss;
}

/** @deprecated Use handleChatWsConnection + ws-router instead */
export function setupChatWs(_server: Server): void {
  // No-op — ws-router handles upgrade now
}

/** Handle a single chat WS connection (called by ws-router) */
export function handleChatWsConnection(clientWs: WebSocket, sessionId: string): void {
  logger.debug({ sessionId }, "Chat WS client connected");

  const config = loadConfig();
  let bridgeWs: WebSocket | null = null;
  let connecting = false; // Guard against concurrent connect attempts
  let currentAssistantContent = "";
  let currentToolCalls: unknown[] = [];
  let closed = false; // Client disconnected flag

  function connectToBridge(): void {
    if (connecting || bridgeWs || closed) return;

    const bridgeUrl = getWorkerUrl(sessionId, config);
    if (!bridgeUrl) return; // Worker not running yet

    connecting = true;
    const wsUrl = bridgeUrl.replace("http://", "ws://") + "/chat/events";
    logger.debug({ sessionId, wsUrl }, "Connecting to bridge WS");

    try {
      const ws = new WebSocket(wsUrl);

      ws.on("open", () => {
        connecting = false;
        bridgeWs = ws;
        markBridgeReady(sessionId);
        logger.debug({ sessionId }, "Bridge WS connected");
      });

      ws.on("message", (data: Buffer) => {
        const line = data.toString();
        try {
          const event = JSON.parse(line);

          // Track assistant content for DB persistence
          if (event.type === "message_start" && event.message?.role === "assistant") {
            currentAssistantContent = "";
            currentToolCalls = [];
          }

          // message_update carries assistantMessageEvent with partial content snapshot
          if (event.type === "message_update") {
            const partial = event.assistantMessageEvent?.partial;
            if (partial?.role === "assistant" && Array.isArray(partial.content)) {
              for (const block of partial.content) {
                if (block.type === "text" && typeof block.text === "string") {
                  currentAssistantContent = block.text;
                }
              }
            }
          }

          // message_end has final content
          if (event.type === "message_end" && event.message?.role === "assistant") {
            const content = event.message.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === "text") currentAssistantContent = block.text ?? "";
              }
            }
            // Persist assistant message to DB
            if (currentAssistantContent) {
              appendMessage({
                sessionId,
                role: "assistant",
                content: currentAssistantContent,
                toolCalls: currentToolCalls.length > 0 ? currentToolCalls : undefined,
              }).catch((err) => logger.warn({ err }, "Failed to persist assistant message"));
            }
          }

          if (event.type === "tool_execution_end") {
            currentToolCalls.push({
              tool: event.name ?? event.tool,
              args: event.args_summary ?? "",
              result: event.result_summary ?? "",
            });
          }

          // Forward to client with session_id
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({ session_id: sessionId, ...event }));
          }
        } catch {
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(line);
          }
        }
      });

      ws.on("close", () => {
        if (bridgeWs === ws) {
          bridgeWs = null;
          resetBridgeReady(sessionId);
        }
        connecting = false;
        // Retry is handled by the setInterval below — no extra setTimeout here
      });

      ws.on("error", (err) => {
        logger.debug({ sessionId, err: err.message }, "Bridge WS error");
        if (bridgeWs === ws) bridgeWs = null;
        connecting = false;
      });
    } catch {
      connecting = false;
    }
  }

  // Try connecting to bridge immediately
  connectToBridge();

  // Retry every 3s if not connected (worker may be starting)
  const retryTimer = setInterval(() => {
    if (!bridgeWs && !connecting && clientWs.readyState === WebSocket.OPEN) {
      connectToBridge();
    }
  }, 3000);

  function cleanup(): void {
    closed = true;
    clearInterval(retryTimer);
    if (bridgeWs) {
      bridgeWs.close();
      bridgeWs = null;
    }
    resetBridgeReady(sessionId);
    logger.debug({ sessionId }, "Chat WS client disconnected");
  }

  clientWs.on("close", cleanup);
  clientWs.on("error", cleanup);
}
