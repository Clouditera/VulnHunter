import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { authRouter, adminAuthRouter } from "./features/auth/index.js";
import { sandboxCapacityRouter } from "./features/sandboxes/capacity-routes.js";
import { systemRouter, adminSystemRouter } from "./features/system/index.js";
import { tasksRouter } from "./features/tasks/index.js";
import { filesRouter } from "./features/files/index.js";
import { findingsRouter } from "./features/findings/index.js";
import { artifactsRouter } from "./features/artifacts/index.js";
import { dashboardRouter } from "./features/dashboard/index.js";
import { workspaceRouter } from "./features/workspace/index.js";
import { settingsRouter } from "./features/settings/index.js";
import { chatRouter } from "./features/chat/index.js";
import { feedbackRouter } from "./features/feedback/routes.js";
import { reportsRouter } from "./features/reports/routes.js";
import { wikiRouter } from "./features/wiki/routes.js";
import { notificationRouter } from "./features/notifications/index.js";
import { pocRouter } from "./features/poc/routes.js";
import { downloadsRouter } from "./features/downloads/routes.js";
import { sandboxPlaneInternalRouter } from "./features/sandbox-plane/routes.js";
import { modelProxyInternalRouter } from "./features/model-proxy/routes.js";
import { mountAdminRoutes } from "./features/admin/index.js";
import { setupWsRouter } from "./ws-router.js";
import { mcpRouter } from "./mcp/index.js";
import { injectUser, forbidAdmin } from "./middleware/index.js";
import { traceId } from "./middleware/trace-id.js";
import { errorHandler } from "./middleware/error-handler.js";
import { logger } from "./infra/logger.js";

export type ServiceRole = "business" | "admin";

/** Business API prefixes blocked for admin role accounts. */
const ADMIN_FORBIDDEN_PREFIXES = [
  "/api/tasks",
  "/api/git",
  "/api/dashboard",
  "/api/settings",
  "/api/chat",
  "/api/feedback",
  "/api/notifications",
  "/api/downloads",
  "/api/sandbox",
] as const;

function mountForbidAdmin(app: Hono): void {
  for (const prefix of ADMIN_FORBIDDEN_PREFIXES) {
    app.use(prefix, forbidAdmin);
    app.use(`${prefix}/*`, forbidAdmin);
  }
}

export function createApp(role: ServiceRole = "business"): Hono {
  const app = new Hono();

  // Global middleware
  app.use("*", traceId);
  app.use("*", cors({ origin: "*", credentials: true }));
  app.use("*", injectUser);

  app.get("/health", (c) => c.json({ ok: true, role }));

  if (role === "admin") {
    // admin-api: auth subset + system subset + /api/admin/*
    app.route("/api/system", adminSystemRouter);
    app.route("/api/auth", adminAuthRouter);
    // community users mounted here; enterprise attaches /api/admin/users in initEnterprise
    const edition = (process.env.EDITION ?? "community").toLowerCase();
    mountAdminRoutes(app, { mountCommunityUsers: edition !== "enterprise" });
    app.onError(errorHandler);
    return app;
  }

  // ── business role ──────────────────────────────────────────────
  mountForbidAdmin(app);

  // Public routes
  app.route("/api/system", systemRouter);
  app.route("/api/auth", authRouter);
  // /api/admin/* intentionally NOT mounted on business service (404)
  app.route("/api/sandbox", sandboxCapacityRouter);

  // Protected business routes
  app.route("/api/tasks", tasksRouter);
  app.route("/api/tasks", findingsRouter);
  app.route("/api/tasks", artifactsRouter);
  app.route("/api/tasks", workspaceRouter);
  app.route("/api/tasks", wikiRouter);
  app.route("/api/dashboard", dashboardRouter);
  app.route("/api/settings", settingsRouter);
  app.route("/api/chat", chatRouter);
  app.route("/api/feedback", feedbackRouter);
  app.route("/api", reportsRouter);
  app.route("/api", filesRouter);

  app.route("/api/tasks", pocRouter);
  app.route("/api", notificationRouter);
  // POC settings routes removed (dead config offline; live fields → env)
  app.route("/api/downloads", downloadsRouter);

  app.route("/internal/sandbox-plane", sandboxPlaneInternalRouter);
  app.route("/internal/model-proxy", modelProxyInternalRouter);
  app.route("/mcp", mcpRouter);

  app.onError(errorHandler);
  return app;
}

export function startServer(port: number, app: Hono = createApp()): void {
  const httpServer = serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, (info) => {
    logger.info({ port: info.port }, `VulnHunter Service listening`);
  }) as unknown as Server;

  // Unified WebSocket routing (live-log + chat) — business only uses WS in practice
  setupWsRouter(httpServer);
}
