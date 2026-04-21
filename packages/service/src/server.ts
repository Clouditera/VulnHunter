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
import { createLiveLogWss } from "./features/events/index.js";
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
  app.route("/api", filesRouter); // includes POST /api/tasks (upload)

  app.onError(errorHandler);

  return app;
}

export function startServer(port: number): void {
  const app = createApp();

  const httpServer = serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, (info) => {
    logger.info({ port: info.port }, `VulnHunt Service listening`);
  }) as unknown as Server;

  // Attach Live Log WebSocket server to the same HTTP server
  createLiveLogWss(httpServer);
  logger.info("Live Log WebSocket server attached at /ws/live-log");
}
