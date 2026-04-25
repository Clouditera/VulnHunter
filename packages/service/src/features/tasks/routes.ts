import { Hono } from "hono";
import { requireAuth } from "../../middleware/auth.js";
import { licenseGuard } from "../../middleware/license-guard.js";
import * as taskStorage from "./storage.js";
import { stopScanWorker, cleanupScanWorkDir } from "../workers/scan-worker.js";
import { getAllEvents } from "../events/event-store.js";
import { translateYoungflowEvent } from "../events/event-tail.js";
import type { LiveLogEvent } from "@vulnhunt/shared";
import { listCredentials } from "../settings/storage.js";
import { notify } from "../notifications/index.js";
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

  // Enrich with credential label if set
  let credential_label: string | null = null;
  if (task.credential_id) {
    const creds = await listCredentials();
    const cred = creds.find((c) => c.id === task.credential_id);
    credential_label = cred ? `${cred.label || cred.provider} — ${cred.model_id}` : null;
  }

  return c.json({ task: { ...task, credential_label } });
});

// POST /api/tasks/:id/cancel
tasksRouter.post("/:id/cancel", async (c) => {
  const task = await taskStorage.getTaskById(c.req.param("id"));
  if (!task) return c.json({ error: { code: "ERR_TASK_NOT_FOUND" } }, 404);
  if (!["running", "paused", "queued"].includes(task.state)) {
    return c.json({ error: { code: "ERR_INTERNAL", detail: "Cannot cancel in current state" } }, 409);
  }
  // Set DB state BEFORE stopping container to prevent die handler race
  await taskStorage.updateTaskState(task.id, "cancelled", { completedAt: new Date() });
  if (task.state === "running") {
    await stopScanWorker(task.id).catch((err) => {
      logger.warn({ err, taskId: task.id }, "Failed to stop container on cancel");
    });
  }
  notify({ type: "task_state", taskId: task.id, state: "cancelled" });
  return c.json({ ok: true });
});

// POST /api/tasks/:id/pause
tasksRouter.post("/:id/pause", async (c) => {
  const task = await taskStorage.getTaskById(c.req.param("id"));
  if (!task) return c.json({ error: { code: "ERR_TASK_NOT_FOUND" } }, 404);
  if (task.state !== "running") {
    return c.json({ error: { code: "ERR_INTERNAL", detail: "Task is not running" } }, 409);
  }
  // Set DB state BEFORE stopping container to prevent die handler race
  await taskStorage.updateTaskState(task.id, "paused");
  await stopScanWorker(task.id).catch((err) => {
    logger.warn({ err, taskId: task.id }, "Failed to stop worker on pause");
  });
  notify({ type: "task_state", taskId: task.id, state: "paused" });
  return c.json({ ok: true });
});

// POST /api/tasks/:id/resume
tasksRouter.post("/:id/resume", async (c) => {
  const task = await taskStorage.getTaskById(c.req.param("id"));
  if (!task) return c.json({ error: { code: "ERR_TASK_NOT_FOUND" } }, 404);
  if (task.state !== "paused") {
    return c.json({ error: { code: "ERR_INTERNAL", detail: "Task is not paused" } }, 409);
  }
  // Clear stale fields from pause and set to queued
  const db = (await import("../../infra/db/client.js")).getDb();
  await db`
    UPDATE tasks
    SET state = 'queued',
        completed_at = NULL,
        failure_reason = NULL,
        duration_ms = NULL
    WHERE id = ${task.id}
  `;
  notify({ type: "task_state", taskId: task.id, state: "queued" });
  return c.json({ ok: true });
});

// POST /api/tasks/:id/restart — full reset per architecture spec §3
tasksRouter.post("/:id/restart", async (c) => {
  const task = await taskStorage.getTaskById(c.req.param("id"));
  if (!task) return c.json({ error: { code: "ERR_TASK_NOT_FOUND" } }, 404);
  if (!["failed", "cancelled", "completed"].includes(task.state)) {
    return c.json({ error: { code: "ERR_INTERNAL", detail: "Cannot restart in current state" } }, 409);
  }

  try {
    const { assertNoActiveOperation } = await import("./operation-lock.js");
    await assertNoActiveOperation(task.id, "scan");
  } catch (err: any) {
    if (err.code === "ERR_TASK_BUSY") return c.json({ error: { code: "ERR_TASK_BUSY", message: err.message, active: err.active } }, 409);
    throw err;
  }

  const config = loadConfig();
  const minio = getMinio();

  // 1. Reset DB state (clears started_at, metadata, findings)
  await taskStorage.resetTaskForRestart(task.id);

  // 2. Clean host workspace so scheduler re-prepares it
  cleanupScanWorkDir(config.dataDir, task.id);

  // 3. Clean MinIO scan-outputs (keep code-packages — zip is reusable)
  try {
    const prefix = `scan-outputs/${task.id}/`;
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
  } catch (err) {
    logger.warn({ err, taskId: task.id }, "Failed to cleanup MinIO scan-outputs on restart");
  }

  notify({ type: "task_state", taskId: task.id, state: "queued" });
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

// NOTE: POC routes moved to features/poc/routes.ts (pocRouter)
// Old GET /:id/poc and GET /:id/poc/:filename removed to avoid route conflict.

// GET /api/tasks/:id/events — live log events (in-memory for running, MinIO archive for completed)
tasksRouter.get("/:id/events", async (c) => {
  const task = await taskStorage.getTaskById(c.req.param("id"));
  if (!task) return c.json({ error: { code: "ERR_TASK_NOT_FOUND" } }, 404);

  // In-memory events (from active tailing — may contain poc/report/scan events)
  const memEvents = getAllEvents(task.id);

  // For completed/terminal tasks, also load archived events from MinIO
  // For running tasks with in-memory events, return those directly
  if (memEvents.length > 0 && ["running", "paused"].includes(task.state)) {
    return c.json({ events: memEvents });
  }

  // Read archived events from MinIO + merge with in-memory
  const config = loadConfig();
  const minio = getMinio();
  const prefix = `scan-outputs/${task.id}/.youngflow/logs/`;

  try {
    // List all .service.jsonl files
    const keys: string[] = [];
    const stream = minio.listObjects(config.minio.bucket, prefix, true);
    for await (const obj of stream) {
      if (obj.name?.endsWith(".service.jsonl") || obj.name?.endsWith("youngflow.service.jsonl")) {
        keys.push(obj.name);
      }
    }

    if (keys.length === 0) {
      // Fallback: read from local workspace (cancelled/failed tasks may not have synced to MinIO)
      const { existsSync, readFileSync, readdirSync } = await import("node:fs");
      const { join } = await import("node:path");
      const localLogsDir = join(config.dataDir, "workspaces", task.id, "out", ".youngflow", "logs");
      if (existsSync(localLogsDir)) {
        const localFiles = readdirSync(localLogsDir).filter(f => f.endsWith(".service.jsonl"));
        const localEvents: { seq: number; event: LiveLogEvent }[] = [];
        let localSeq = 0;
        for (const file of localFiles) {
          try {
            const text = readFileSync(join(localLogsDir, file), "utf-8");
            for (const line of text.split("\n")) {
              if (!line.trim()) continue;
              try {
                const raw = JSON.parse(line);
                if (!raw.event) continue;
                const translated = translateYoungflowEvent(raw, "scan");
                if (translated) {
                  localSeq++;
                  translated.seq = localSeq;
                  localEvents.push({ seq: localSeq, event: translated });
                }
              } catch { /* skip */ }
            }
          } catch { /* skip */ }
        }
        if (localEvents.length > 0) {
          return c.json({ events: localEvents });
        }
      }
      return c.json({ events: [] });
    }

    const events: { seq: number; event: LiveLogEvent }[] = [];
    let seq = 0;

    for (const key of keys) {
      try {
        const objStream = await minio.getObject(config.minio.bucket, key);
        const chunks: Buffer[] = [];
        for await (const chunk of objStream) chunks.push(Buffer.from(chunk));
        const text = Buffer.concat(chunks).toString("utf-8");

        for (const line of text.split("\n")) {
          if (!line.trim()) continue;
          try {
            const raw = JSON.parse(line);
            if (!raw.event) continue;
            const translated = translateYoungflowEvent(raw, "scan");
            if (translated) {
              seq++;
              translated.seq = seq;
              events.push({ seq, event: translated });
            }
          } catch { /* skip malformed lines */ }
        }
      } catch { /* skip unreadable files */ }
    }

    // Merge archived events with in-memory events (dedup by checking if memEvents exist)
    const allEvents = [...events, ...memEvents];
    return c.json({ events: allEvents });
  } catch (err) {
    logger.warn({ err, taskId: task.id }, "Failed to load archived events");
    // Fall back to in-memory only
    return c.json({ events: memEvents });
  }
});
