/**
 * Unified WebSocket routing — all WS upgrades go through here.
 * Chat + live-log require authenticated session cookie and resource ownership.
 */

import { WebSocketServer } from "ws";
import type { Server } from "node:http";
import { logger } from "./infra/logger.js";
import { handleLiveLogConnection } from "./features/events/ws-live-log.js";
import { handleChatWsConnection } from "./features/chat/ws-chat.js";
import { rejectUpgrade, resolveUserFromUpgrade } from "./ws-auth.js";
import { getSessionForContext } from "./features/chat/storage.js";
import { queryContextFromUser } from "./infra/query-context.js";

export function setupWsRouter(server: Server): void {
  const liveLogWss = new WebSocketServer({ noServer: true });
  const chatWss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const url = request.url ?? "";

    void (async () => {
      try {
        if (url === "/ws/live-log" || url.startsWith("/ws/live-log?")) {
          const user = await resolveUserFromUpgrade(request);
          if (!user) {
            rejectUpgrade(socket, 401, "Unauthorized");
            return;
          }
          liveLogWss.handleUpgrade(request, socket, head, (ws) => {
            handleLiveLogConnection(ws, request, user);
          });
          return;
        }

        const chatMatch = url.match(/^\/ws\/chat\/([a-f0-9-]+)$/i);
        if (chatMatch) {
          const sessionId = chatMatch[1];
          const user = await resolveUserFromUpgrade(request);
          if (!user) {
            rejectUpgrade(socket, 401, "Unauthorized");
            return;
          }
          const owned = await getSessionForContext(sessionId, queryContextFromUser(user));
          if (!owned) {
            rejectUpgrade(socket, 403, "Forbidden");
            return;
          }
          chatWss.handleUpgrade(request, socket, head, (ws) => {
            handleChatWsConnection(ws, sessionId);
          });
          return;
        }

        socket.destroy();
      } catch (err) {
        logger.warn({ err, url }, "WS upgrade auth failed");
        try {
          rejectUpgrade(socket, 401, "Unauthorized");
        } catch {
          socket.destroy();
        }
      }
    })();
  });

  logger.info("WebSocket router attached: /ws/live-log + /ws/chat/:sessionId (auth required)");
}
