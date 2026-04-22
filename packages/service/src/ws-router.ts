/**
 * Unified WebSocket routing — all WS upgrades go through here.
 * Prevents multiple WebSocketServer instances from conflicting on the same HTTP server.
 */

import { WebSocketServer } from "ws";
import type { Server } from "node:http";
import { logger } from "./infra/logger.js";

// Import WS handlers
import { handleLiveLogConnection } from "./features/events/ws-live-log.js";
import { handleChatWsConnection } from "./features/chat/ws-chat.js";

export function setupWsRouter(server: Server): void {
  const liveLogWss = new WebSocketServer({ noServer: true });
  const chatWss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const url = request.url ?? "";

    if (url === "/ws/live-log" || url.startsWith("/ws/live-log?")) {
      liveLogWss.handleUpgrade(request, socket, head, (ws) => {
        handleLiveLogConnection(ws, request);
      });
    } else if (/^\/ws\/chat\/[a-f0-9-]+$/.test(url)) {
      const sessionId = url.split("/").pop()!;
      chatWss.handleUpgrade(request, socket, head, (ws) => {
        handleChatWsConnection(ws, sessionId);
      });
    } else {
      socket.destroy();
    }
  });

  logger.info("WebSocket router attached: /ws/live-log + /ws/chat/:sessionId");
}
