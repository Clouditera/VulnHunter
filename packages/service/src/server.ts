import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { authRouter } from "./features/auth/index.js";
import { systemRouter } from "./features/license/index.js";
import { tasksRouter } from "./features/tasks/index.js";
import { filesRouter } from "./features/files/index.js";
import { findingsRouter } from "./features/findings/index.js";
import { dashboardRouter } from "./features/dashboard/index.js";
import { workspaceRouter } from "./features/workspace/index.js";
import { settingsRouter } from "./features/settings/index.js";
import { chatRouter } from "./features/chat/index.js";
import { reportsRouter } from "./features/reports/routes.js";
import { notificationRouter } from "./features/notifications/index.js";
import { setupWsRouter } from "./ws-router.js";
import { mcpRouter } from "./mcp/index.js";
import { injectUser } from "./middleware/index.js";
import { traceId } from "./middleware/trace-id.js";
import { errorHandler } from "./middleware/error-handler.js";
import { logger } from "./infra/logger.js";

export function createApp(): Hono {
  const app = new Hono();

  // Global middleware
  app.use("*", traceId);
  app.use("*", cors({ origin: "*", credentials: true }));
  app.use("*", injectUser);

  // Public routes (no license, no auth)
  app.route("/api/system", systemRouter);
  app.route("/api/auth", authRouter);

  // Health check
  app.get("/health", (c) => c.json({ ok: true }));

  // Protected routes (license + auth)
  app.route("/api/tasks", tasksRouter);
  app.route("/api/tasks", findingsRouter); // /:taskId/findings
  app.route("/api/tasks", workspaceRouter); // /:taskId/workspace/*
  app.route("/api/dashboard", dashboardRouter);
  app.route("/api/settings", settingsRouter);
  app.route("/api/chat", chatRouter);
  app.route("/api", reportsRouter); // skills + reports
  app.route("/api", filesRouter); // includes POST /api/tasks (upload)

  // SSE notifications (task state changes, findings indexed, etc.)
  app.route("/api", notificationRouter);

  // MCP server for Chat agent tools (no license/auth middleware — has own auth)
  app.route("/mcp", mcpRouter);

  app.onError(errorHandler);

  return app;
}

export function startServer(port: number): void {
  const app = createApp();

  const httpServer = serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, (info) => {
    logger.info({ port: info.port }, `VulnHunt Service listening`);
  }) as unknown as Server;

  // Unified WebSocket routing (live-log + chat)
  setupWsRouter(httpServer);
}
