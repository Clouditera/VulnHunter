import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { authRouter } from "./features/auth/index.js";
import { systemRouter } from "./features/license/index.js";
import { tasksRouter } from "./features/tasks/index.js";
import { filesRouter } from "./features/files/index.js";
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
  app.route("/api", filesRouter); // includes POST /api/tasks (upload)

  app.onError(errorHandler);

  return app;
}

export function startServer(port: number): void {
  const app = createApp();

  serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, (info) => {
    logger.info({ port: info.port }, `VulnHunt Service listening`);
  });
}
