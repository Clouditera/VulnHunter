import { Hono } from "hono";
import { requireAuth } from "../../middleware/auth.js";
import { licenseGuard } from "../../middleware/license-guard.js";
import * as taskStorage from "./storage.js";
import { cleanupScanWorkDir } from "../workers/scan-worker.js";
import { getAllEvents } from "../events/event-store.js";
import { translateYoungflowEvent } from "../events/event-tail.js";
import type { LiveLogEvent } from "@vulnhunt/shared";
import { listCredentials } from "../settings/storage.js";
import { cancelTask, pauseTask, restartTask, resumeTask, TaskControlError } from "./control-service.js";
import { loadConfig } from "../../infra/config.js";
import { getMinio } from "../../infra/minio/client.js";
import { logger } from "../../infra/logger.js";

export const tasksRouter = new Hono();

function controlErrorResponse(c: any, err: unknown) {
  if (err instanceof TaskControlError) {
    return c.json({ error: { code: err.code, message: err.message, ...(err.extra ?? {}) } }, err.status as 404 | 409);
  }
  throw err;
}

// All tasks routes require license + auth
tasksRouter.use("*", licenseGuard);
tasksRouter.use("*", requireAuth);

// GET /api/tasks
tasksRouter.get("/", async (c) => {
  const state = c.req.query("state") as string | undefined;
  const reviewStatus = c.req.query("review_status") as string | undefined;
  const limit = Math.min(Number(c.req.query("limit") ?? 50), 100);
  const offset = Number(c.req.query("offset") ?? 0);

  if (reviewStatus) {
    const { isFindingReviewStatus } = await import("../findings/storage.js");
    if (!isFindingReviewStatus(reviewStatus)) {
      return c.json({ error: { code: "ERR_VALIDATION", message: "Invalid review_status" } }, 400);
    }
  }

  const tasks = await taskStorage.listTasks({ state: state as never, reviewStatus, limit, offset });

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
  try {
    await cancelTask(c.req.param("id"));
    return c.json({ ok: true });
  } catch (err) {
    return controlErrorResponse(c, err);
  }
});

// POST /api/tasks/:id/pause
tasksRouter.post("/:id/pause", async (c) => {
  try {
    await pauseTask(c.req.param("id"));
    return c.json({ ok: true });
  } catch (err) {
    return controlErrorResponse(c, err);
  }
});

// POST /api/tasks/:id/resume
tasksRouter.post("/:id/resume", async (c) => {
  try {
    await resumeTask(c.req.param("id"));
    return c.json({ ok: true });
  } catch (err) {
    return controlErrorResponse(c, err);
  }
});

// POST /api/tasks/:id/restart — full reset per architecture spec §3
tasksRouter.post("/:id/restart", async (c) => {
  try {
    await restartTask(c.req.param("id"));
    return c.json({ ok: true });
  } catch (err) {
    return controlErrorResponse(c, err);
  }
});

// PATCH /api/tasks/:id — update task properties (credential_id)
const EDITABLE_STATES = new Set(["paused", "cancelled", "failed", "completed"]);
tasksRouter.patch("/:id", async (c) => {
  const task = await taskStorage.getTaskById(c.req.param("id"));
  if (!task) return c.json({ error: { code: "ERR_TASK_NOT_FOUND" } }, 404);
  if (!EDITABLE_STATES.has(task.state)) {
    return c.json({ error: { code: "ERR_INVALID_STATE", detail: `Cannot edit task in '${task.state}' state` } }, 409);
  }

  const body = await c.req.json<{ credential_id?: string | null }>();
  if (body.credential_id !== undefined) {
    // Validate credential exists (unless null = clear)
    if (body.credential_id !== null) {
      const creds = await listCredentials();
      if (!creds.find((cr) => cr.id === body.credential_id)) {
        return c.json({ error: { code: "ERR_NOT_FOUND", detail: "Credential not found" } }, 404);
      }
    }
    await taskStorage.updateTaskCredential(task.id, body.credential_id);
  }

  const updated = await taskStorage.getTaskById(task.id);
  return c.json(updated);
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

  // If in-memory has events for running tasks, return them directly (fast path).
  // Otherwise fall through to load from MinIO/local files (handles service restart).

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
