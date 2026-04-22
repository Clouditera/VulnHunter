import { Hono } from "hono";
import { requireAuth } from "../../middleware/auth.js";
import { licenseGuard } from "../../middleware/license-guard.js";
import * as taskStorage from "./storage.js";
import { stopScanWorker, cleanupScanWorkDir } from "../workers/scan-worker.js";
import { loadConfig } from "../../infra/config.js";
import { getMinio } from "../../infra/minio/client.js";
import { logger } from "../../infra/logger.js";

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

  // Enrich with findings severity counts
  const taskIds = tasks.map((t) => t.id);
  const severityCounts = taskIds.length > 0
    ? await taskStorage.getFindingsSeverityCounts(taskIds)
    : new Map<string, Record<string, number>>();

  const enriched = tasks.map((t) => ({
    ...t,
    severity_counts: severityCounts.get(t.id) ?? { high: 0, medium: 0, low: 0, info: 0 },
  }));

  return c.json({ tasks: enriched });
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
  if (task.state === "running") {
    await stopScanWorker(task.id).catch((err) => {
      // Log but don't fail — container may already be gone
      console.warn("Failed to stop container:", err);
    });
  }
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
  // Stop the worker container (youngflow checkpoint is preserved in workspace)
  await stopScanWorker(task.id).catch((err) => {
    logger.warn({ err, taskId: task.id }, "Failed to stop worker on pause");
  });
  await taskStorage.updateTaskState(task.id, "paused");
  return c.json({ ok: true });
});

// POST /api/tasks/:id/resume
tasksRouter.post("/:id/resume", async (c) => {
  const task = await taskStorage.getTaskById(c.req.param("id"));
  if (!task) return c.json({ error: { code: "ERR_TASK_NOT_FOUND" } }, 404);
  if (task.state !== "paused") {
    return c.json({ error: { code: "ERR_INTERNAL", detail: "Task is not paused" } }, 409);
  }
  // Set to queued — scheduler picks it up with resume=true
  await taskStorage.updateTaskState(task.id, "queued");
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

// DELETE /api/tasks/:id
tasksRouter.delete("/:id", async (c) => {
  const task = await taskStorage.getTaskById(c.req.param("id"));
  if (!task) return c.json({ error: { code: "ERR_TASK_NOT_FOUND" } }, 404);
  if (["running", "queued"].includes(task.state)) {
    return c.json({ error: { code: "ERR_INTERNAL", detail: "Cancel or wait for task to finish before deleting" } }, 409);
  }

  const config = loadConfig();
  const minio = getMinio();

  // Delete from DB (cascades to findings_meta)
  await taskStorage.deleteTask(task.id);

  // Cleanup MinIO objects (best-effort)
  try {
    const prefixes = [`code-packages/${task.id}`, `scan-outputs/${task.id}/`];
    for (const prefix of prefixes) {
      const objects = await new Promise<string[]>((resolve, reject) => {
        const keys: string[] = [];
        const stream = minio.listObjects(config.minio.bucket, prefix, true);
        stream.on("data", (obj) => { if (obj.name) keys.push(obj.name); });
        stream.on("end", () => resolve(keys));
        stream.on("error", reject);
      });
      if (objects.length > 0) {
        await minio.removeObjects(config.minio.bucket, objects);
      }
    }
  } catch (err) {
    logger.warn({ err, taskId: task.id }, "Failed to cleanup MinIO objects");
  }

  // Cleanup local workspace (best-effort)
  cleanupScanWorkDir(config.dataDir, task.id);

  return c.json({ ok: true });
});

// GET /api/tasks/:id/poc — list POC files from scan outputs
tasksRouter.get("/:id/poc", async (c) => {
  const task = await taskStorage.getTaskById(c.req.param("id"));
  if (!task) return c.json({ error: { code: "ERR_TASK_NOT_FOUND" } }, 404);

  const config = loadConfig();
  const minio = getMinio();

  // Look for POC files in scan-outputs (multiple possible locations)
  const searchPrefixes = [
    `scan-outputs/${task.id}/poc/`,
    `scan-outputs/${task.id}/exploits/`,
  ];

  const pocFiles: Array<{ key: string; name: string; size: number }> = [];
  for (const prefix of searchPrefixes) {
    try {
      const stream = minio.listObjects(config.minio.bucket, prefix, true);
      await new Promise<void>((resolve, reject) => {
        stream.on("data", (obj) => {
          if (obj.name) {
            pocFiles.push({
              key: obj.name,
              name: obj.name.split("/").pop() ?? obj.name,
              size: obj.size ?? 0,
            });
          }
        });
        stream.on("end", resolve);
        stream.on("error", reject);
      });
    } catch {
      // prefix not found, skip
    }
  }

  return c.json({ poc_files: pocFiles });
});

// GET /api/tasks/:id/poc/:filename — read a specific POC file content
tasksRouter.get("/:id/poc/:filename", async (c) => {
  const { id, filename } = c.req.param();
  const task = await taskStorage.getTaskById(id);
  if (!task) return c.json({ error: { code: "ERR_TASK_NOT_FOUND" } }, 404);

  const config = loadConfig();
  const minio = getMinio();
  const key = c.req.query("key");
  if (!key) return c.json({ error: { code: "ERR_INTERNAL", detail: "key query param required" } }, 400);

  try {
    const stream = await minio.getObject(config.minio.bucket, key);
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", resolve);
      stream.on("error", reject);
    });
    return c.json({ filename, content: Buffer.concat(chunks).toString("utf-8") });
  } catch {
    return c.json({ error: { code: "ERR_NOT_FOUND" } }, 404);
  }
});
