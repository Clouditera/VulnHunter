import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { authRouter } from "./features/auth/index.js";
import { systemRouter } from "./features/system/index.js";
import { tasksRouter } from "./features/tasks/index.js";
import { filesRouter } from "./features/files/index.js";
import { findingsRouter } from "./features/findings/index.js";
import { artifactsRouter } from "./features/artifacts/index.js";
import { dashboardRouter } from "./features/dashboard/index.js";
import { workspaceRouter } from "./features/workspace/index.js";
import { settingsRouter } from "./features/settings/index.js";
import { chatRouter } from "./features/chat/index.js";
import { reportsRouter } from "./features/reports/routes.js";
import { wikiRouter } from "./features/wiki/routes.js";
import { notificationRouter } from "./features/notifications/index.js";
import { pocRouter } from "./features/poc/routes.js";
import { pocSettingsRouter } from "./features/poc/settings-routes.js";
import { downloadsRouter } from "./features/downloads/routes.js";
import { sandboxPlaneInternalRouter } from "./features/sandbox-plane/routes.js";
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
  app.route("/api/tasks", artifactsRouter); // /:taskId/findings/:findingId/artifacts, /:taskId/exploits, /:taskId/artifacts/file
  app.route("/api/tasks", workspaceRouter); // /:taskId/workspace/*
  app.route("/api/tasks", wikiRouter); // /:taskId/wiki
  app.route("/api/dashboard", dashboardRouter);
  app.route("/api/settings", settingsRouter);
  app.route("/api/chat", chatRouter);
  app.route("/api", reportsRouter); // skills + reports
  app.route("/api", filesRouter); // includes POST /api/tasks (upload)

  // POC/EXP generation
  app.route("/api/tasks", pocRouter); // /:taskId/poc/*

  // SSE notifications (task state changes, findings indexed, etc.)
  app.route("/api", notificationRouter);

  // POC settings
  app.route("/api/settings", pocSettingsRouter);
  app.route("/api/downloads", downloadsRouter);

  // Internal read-only SandboxPlane proxy for the Prepare worker's
  // sandbox-plane extension (own task-id-bearer auth, no license/user auth).
  app.route("/internal/sandbox-plane", sandboxPlaneInternalRouter);

  // MCP server for Chat agent tools (no license/auth middleware — has own auth)
  app.route("/mcp", mcpRouter);

  app.onError(errorHandler);

  return app;
}

export function startServer(port: number, app: Hono = createApp()): void {
  const httpServer = serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, (info) => {
    logger.info({ port: info.port }, `VulnAgent Service listening`);
  }) as unknown as Server;

  // Unified WebSocket routing (live-log + chat)
  setupWsRouter(httpServer);
}
