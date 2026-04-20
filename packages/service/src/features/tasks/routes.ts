import { Hono } from "hono";
import { requireAuth } from "../../middleware/auth.js";
import { licenseGuard } from "../../middleware/license-guard.js";
import * as taskStorage from "./storage.js";

export const tasksRouter = new Hono();

// All tasks routes require license + auth
tasksRouter.use("*", licenseGuard);
tasksRouter.use("*", requireAuth);

// GET /api/tasks
tasksRouter.get("/", async (c) => {
  const state = c.req.query("state") as string | undefined;
  const limit = Math.min(Number(c.req.query("limit") ?? 50), 100);
  const offset = Number(c.req.query("offset") ?? 0);

  const tasks = await taskStorage.listTasks({ state: state as never, limit, offset });
  return c.json({ tasks });
});

// GET /api/tasks/:id
tasksRouter.get("/:id", async (c) => {
  const task = await taskStorage.getTaskById(c.req.param("id"));
  if (!task) return c.json({ error: { code: "ERR_TASK_NOT_FOUND" } }, 404);
  return c.json({ task });
});

// POST /api/tasks/:id/cancel
tasksRouter.post("/:id/cancel", async (c) => {
  const task = await taskStorage.getTaskById(c.req.param("id"));
  if (!task) return c.json({ error: { code: "ERR_TASK_NOT_FOUND" } }, 404);
  if (!["running", "paused", "queued"].includes(task.state)) {
    return c.json({ error: { code: "ERR_INTERNAL", detail: "Cannot cancel in current state" } }, 409);
  }
  // WorkerManager will handle actual container cleanup
  await taskStorage.updateTaskState(task.id, "cancelled");
  return c.json({ ok: true });
});

// POST /api/tasks/:id/pause
tasksRouter.post("/:id/pause", async (c) => {
  const task = await taskStorage.getTaskById(c.req.param("id"));
  if (!task) return c.json({ error: { code: "ERR_TASK_NOT_FOUND" } }, 404);
  if (task.state !== "running") {
    return c.json({ error: { code: "ERR_INTERNAL", detail: "Task is not running" } }, 409);
  }
  await taskStorage.updateTaskState(task.id, "paused");
  return c.json({ ok: true });
});

// POST /api/tasks/:id/restart
tasksRouter.post("/:id/restart", async (c) => {
  const task = await taskStorage.getTaskById(c.req.param("id"));
  if (!task) return c.json({ error: { code: "ERR_TASK_NOT_FOUND" } }, 404);
  if (!["failed", "cancelled", "completed"].includes(task.state)) {
    return c.json({ error: { code: "ERR_INTERNAL", detail: "Cannot restart in current state" } }, 409);
  }
  await taskStorage.updateTaskState(task.id, "queued");
  return c.json({ ok: true });
});
