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

export function createChatWss(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: /^\/ws\/chat\/[a-f0-9-]+$/ as unknown as string });

  // WebSocketServer with regex path doesn't work. Use noServer mode instead.
  return wss;
}

/**
 * Set up chat WS handling on the HTTP server.
 * We use the upgrade event directly to support dynamic session paths.
 */
export function setupChatWs(server: Server): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const url = request.url ?? "";

    // Match /ws/chat/<session-id>
    const match = url.match(/^\/ws\/chat\/([a-f0-9-]+)$/);
    if (!match) return; // Not a chat WS request, let other handlers deal with it

    const sessionId = match[1];

    wss.handleUpgrade(request, socket, head, (ws) => {
      handleChatConnection(ws, sessionId);
    });
  });
}

function handleChatConnection(clientWs: WebSocket, sessionId: string): void {
  logger.debug({ sessionId }, "Chat WS client connected");

  const config = loadConfig();
  let bridgeWs: WebSocket | null = null;
  let currentAssistantContent = "";
  let currentToolCalls: unknown[] = [];

  function connectToBridge(): void {
    const bridgeUrl = getWorkerUrl(sessionId, config);
    if (!bridgeUrl) {
      // Worker not running yet — will connect when prompt triggers spawn
      return;
    }

    const wsUrl = bridgeUrl.replace("http://", "ws://") + "/chat/events";
    try {
      bridgeWs = new WebSocket(wsUrl);

      bridgeWs.on("message", (data: Buffer) => {
        const line = data.toString();
        // Forward to client with session_id envelope
        try {
          const event = JSON.parse(line);

          // Track assistant content for DB persistence
          if (event.type === "message_start" && event.message?.role === "assistant") {
            currentAssistantContent = "";
            currentToolCalls = [];
          }
          if (event.type === "message_update" && event.message?.role === "assistant") {
            const content = event.message?.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === "text") currentAssistantContent = block.text ?? "";
              }
            }
          }
          if (event.type === "message_end" && event.message?.role === "assistant") {
            const content = event.message?.content;
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

          // Send to client with session_id
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({ session_id: sessionId, ...event }));
          }
        } catch {
          // Forward raw if can't parse
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(line);
          }
        }
      });

      bridgeWs.on("close", () => {
        bridgeWs = null;
        // Try to reconnect after a delay
        setTimeout(connectToBridge, 3000);
      });

      bridgeWs.on("error", () => {
        bridgeWs = null;
      });
    } catch {
      // Bridge not ready yet
    }
  }

  // Try connecting to bridge immediately
  connectToBridge();

  // Also retry every 3s if not connected (worker may be starting)
  const retryTimer = setInterval(() => {
    if (!bridgeWs && clientWs.readyState === WebSocket.OPEN) {
      connectToBridge();
    }
  }, 3000);

  clientWs.on("close", () => {
    clearInterval(retryTimer);
    if (bridgeWs) {
      bridgeWs.close();
      bridgeWs = null;
    }
    logger.debug({ sessionId }, "Chat WS client disconnected");
  });

  clientWs.on("error", () => {
    clearInterval(retryTimer);
    if (bridgeWs) {
      bridgeWs.close();
      bridgeWs = null;
    }
  });
}
