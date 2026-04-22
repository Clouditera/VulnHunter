/**
 * WS proxy for chat events.
 * Frontend connects to /ws/chat/:sessionId → thin shell that delegates to bridge-proxy.
 */

import { WebSocket } from "ws";
import { subscribeFrontendClient } from "./bridge-proxy.js";
import { logger } from "../../infra/logger.js";

/** Handle a single chat WS connection (called by ws-router) */
export function handleChatWsConnection(clientWs: WebSocket, sessionId: string): void {
  logger.debug({ sessionId }, "Chat WS client connected");
  subscribeFrontendClient(sessionId, clientWs);
}
