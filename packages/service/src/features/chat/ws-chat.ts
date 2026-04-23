/**
 * WS handler for chat events.
 * Frontend connects to /ws/chat/:sessionId → delegates to ChatSession.
 */

import { WebSocket } from "ws";
import { getOrCreateSession } from "./chat-session.js";
import { logger } from "../../infra/logger.js";

/** Handle a single chat WS connection (called by ws-router) */
export function handleChatWsConnection(clientWs: WebSocket, sessionId: string): void {
  logger.debug({ sessionId }, "Chat WS client connected");
  const session = getOrCreateSession(sessionId);
  session.subscribeFrontendClient(clientWs);
}
