import { Hono } from "hono";
import { requireAuth } from "../../middleware/auth.js";
import { licenseGuard } from "../../middleware/license-guard.js";
import * as taskStorage from "./storage.js";
import { cleanupScanWorkDir } from "../workers/scan-worker.js";
import { loadTaskEvents } from "../events/event-archive.js";
import { getEventTotal } from "../events/event-store.js";
import { listCredentials } from "../settings/storage.js";
import { cancelTask, continueTask, pauseTask, restartTask, resumeTask, TaskControlError } from "./control-service.js";
import { releaseSandboxForTask } from "../sandboxes/lifecycle.js";
import { loadConfig } from "../../infra/config.js";
import { getMinio } from "../../infra/minio/client.js";
import { logger } from "../../infra/logger.js";
import { queryContextFromUser } from "../../infra/query-context.js";
import { listUsersByIds } from "../auth/storage.js";
import { attachCreatorSummaries, uniqueCreatorIds } from "../auth/creator-summary.js";
import { originalArchiveDownloadSpec } from "./original-archive.js";
import { getSourceArchivePolicy } from "../source-archives/policy.js";
import { projectSandboxQueue } from "../sandboxes/capacity.js";

export const tasksRouter = new Hono();

function withSandboxQueue<T extends { metadata?: unknown }>(task: T): T & { sandbox_queue: ReturnType<typeof projectSandboxQueue> } {
  return { ...task, sandbox_queue: projectSandboxQueue(task.metadata) };
}

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
  const paginate = c.req.query("paginate") === "1" || c.req.query("paginate") === "true";

  if (reviewStatus) {
    const { isFindingReviewStatus } = await import("../findings/storage.js");
    if (!isFindingReviewStatus(reviewStatus)) {
      return c.json({ error: { code: "ERR_VALIDATION", message: "Invalid review_status" } }, 400);
    }
  }

  const ctx = queryContextFromUser(c.get("user"));
  const filterUserId = ctx.role === "admin" ? c.req.query("user_id") : undefined;

  let limit = Math.min(Number(c.req.query("limit") ?? 50), 100);
  let offset = Number(c.req.query("offset") ?? 0);
  let page = 1;
  let pageSize = limit;
  let total: number | undefined;

  if (paginate) {
    const { getSystemConfig } = await import("../settings/storage.js");
    const cfg = await getSystemConfig();
    const raw = Number(cfg.tasks_page_size ?? 10);
    pageSize = Number.isFinite(raw) ? Math.min(500, Math.max(1, Math.trunc(raw))) : 10;
    page = Math.max(1, Math.trunc(Number(c.req.query("page") ?? 1)) || 1);
    limit = pageSize;
    offset = (page - 1) * pageSize;
    total = await taskStorage.countTasks(ctx, {
      state: state as never,
      reviewStatus,
      userId: filterUserId,
    });
  }

  const tasks = await taskStorage.listTasks(ctx, {
    state: state as never,
    reviewStatus,
    limit,
    offset,
    userId: filterUserId,
  });

  // Enrich with findings severity counts
  const taskIds = tasks.map((t) => t.id);
  const severityCounts = taskIds.length > 0
    ? await taskStorage.getFindingsSeverityCounts(taskIds)
    : new Map<string, Record<string, number>>();

  const rows = tasks.map((t) => withSandboxQueue({
    ...t,
    severity_counts: severityCounts.get(t.id) ?? { high: 0, medium: 0, low: 0, info: 0 },
  }));
  const creators = ctx.role === "admin" ? await listUsersByIds(uniqueCreatorIds(tasks, "created_by")) : [];
  const enriched = attachCreatorSummaries(ctx.role, rows, "created_by", creators);

  if (paginate) {
    const totalVal = total ?? 0;
    const totalPages = Math.max(1, Math.ceil(totalVal / pageSize) || 1);
    return c.json({
      tasks: enriched,
      total: totalVal,
      page,
      page_size: pageSize,
      total_pages: totalPages,
    });
  }

  return c.json({ tasks: enriched });
});

// GET /api/tasks/source-archive-policy — upload policy for New Task UI.
tasksRouter.get("/source-archive-policy", async (c) => {
  return c.json(await getSourceArchivePolicy());
});

// GET /api/tasks/:id/source-archive — download the original uploaded package.
tasksRouter.get("/:id/source-archive", async (c) => {
  const ctx = queryContextFromUser(c.get("user"));
  const task = await taskStorage.getTaskById(ctx, c.req.param("id"));
  if (!task) return c.json({ error: { code: "ERR_TASK_NOT_FOUND" } }, 404);

  const spec = originalArchiveDownloadSpec(task);
  if (!spec) {
    return c.json({ error: { code: "ERR_SOURCE_ARCHIVE_NOT_AVAILABLE", message: "Original uploaded archive is not available for this task" } }, 404);
  }

  const config = loadConfig();
  const minio = getMinio();
  let stat: { size?: number };
  try {
    stat = await minio.statObject(config.minio.bucket, spec.minioKey);
  } catch (err) {
    logger.warn({ err, taskId: task.id, minioKey: spec.minioKey }, "Original source archive not found in MinIO");
    return c.json({ error: { code: "ERR_SOURCE_ARCHIVE_NOT_FOUND", message: "Original uploaded archive is missing" } }, 404);
  }

  const stream = await minio.getObject(config.minio.bucket, spec.minioKey);
  const encoded = encodeURIComponent(spec.filename);
  return new Response(stream as unknown as ReadableStream, {
    headers: {
      "Content-Type": spec.contentType,
      "Content-Disposition": `attachment; filename="${spec.safeFilename}"; filename*=UTF-8''${encoded}`,
      ...(stat.size != null ? { "Content-Length": String(stat.size) } : {}),
    },
  });
});

// GET /api/tasks/:id
tasksRouter.get("/:id", async (c) => {
  const ctx = queryContextFromUser(c.get("user"));
  const task = await taskStorage.getTaskById(ctx, c.req.param("id"));
  if (!task) return c.json({ error: { code: "ERR_TASK_NOT_FOUND" } }, 404);

  // Enrich with credential label if set
  let credential_label: string | null = null;
  if (task.credential_id) {
    const creds = await listCredentials(ctx);
    const cred = creds.find((c) => c.id === task.credential_id);
    credential_label = cred ? `${cred.label || cred.provider} — ${cred.model_id}` : null;
  }

  return c.json({ task: withSandboxQueue({ ...task, credential_label }) });
});

// POST /api/tasks/:id/cancel
tasksRouter.post("/:id/cancel", async (c) => {
  const ctx = queryContextFromUser(c.get("user"));
  const task = await taskStorage.getTaskById(ctx, c.req.param("id"));
  if (!task) return c.json({ error: { code: "ERR_TASK_NOT_FOUND" } }, 404);
  try {
    await cancelTask(task.id);
    return c.json({ ok: true });
  } catch (err) {
    return controlErrorResponse(c, err);
  }
});

// POST /api/tasks/:id/pause
tasksRouter.post("/:id/pause", async (c) => {
  const ctx = queryContextFromUser(c.get("user"));
  const task = await taskStorage.getTaskById(ctx, c.req.param("id"));
  if (!task) return c.json({ error: { code: "ERR_TASK_NOT_FOUND" } }, 404);
  try {
    await pauseTask(task.id);
    return c.json({ ok: true });
  } catch (err) {
    return controlErrorResponse(c, err);
  }
});

// POST /api/tasks/:id/resume
tasksRouter.post("/:id/resume", async (c) => {
  const ctx = queryContextFromUser(c.get("user"));
  const task = await taskStorage.getTaskById(ctx, c.req.param("id"));
  if (!task) return c.json({ error: { code: "ERR_TASK_NOT_FOUND" } }, 404);
  try {
    await resumeTask(task.id);
    return c.json({ ok: true });
  } catch (err) {
    return controlErrorResponse(c, err);
  }
});

// POST /api/tasks/:id/restart — full reset per architecture spec §3
tasksRouter.post("/:id/restart", async (c) => {
  const ctx = queryContextFromUser(c.get("user"));
  const task = await taskStorage.getTaskById(ctx, c.req.param("id"));
  if (!task) return c.json({ error: { code: "ERR_TASK_NOT_FOUND" } }, 404);
  try {
    await restartTask(task.id);
    return c.json({ ok: true });
  } catch (err) {
    return controlErrorResponse(c, err);
  }
});

// POST /api/tasks/:id/continue — re-run with --continue on top of existing outputs
tasksRouter.post("/:id/continue", async (c) => {
  const ctx = queryContextFromUser(c.get("user"));
  const task = await taskStorage.getTaskById(ctx, c.req.param("id"));
  if (!task) return c.json({ error: { code: "ERR_TASK_NOT_FOUND" } }, 404);
  const body = await c.req
    .json<{ audit_focus?: string; scan_timeout?: string | number }>()
    .catch(() => ({} as { audit_focus?: string; scan_timeout?: string | number }));
  const auditFocus =
    typeof body.audit_focus === "string" ? body.audit_focus.trim() : undefined;
  let scanTimeout: number | undefined;
  if (body.scan_timeout !== undefined && body.scan_timeout !== null && body.scan_timeout !== "") {
    const n =
      typeof body.scan_timeout === "number"
        ? body.scan_timeout
        : Number.parseInt(String(body.scan_timeout).trim(), 10);
    if (Number.isFinite(n) && n > 0) scanTimeout = Math.trunc(n);
  }
  try {
    await continueTask(task.id, { auditFocus, scanTimeout });
    return c.json({ ok: true });
  } catch (err) {
    return controlErrorResponse(c, err);
  }
});

// PATCH /api/tasks/:id/display-name — update user-facing task label
tasksRouter.patch("/:id/display-name", async (c) => {
  const ctx = queryContextFromUser(c.get("user"));
  const task = await taskStorage.getTaskById(ctx, c.req.param("id"));
  if (!task) return c.json({ error: { code: "ERR_TASK_NOT_FOUND" } }, 404);
  const body = await c.req.json<{ display_name?: string | null }>().catch(() => ({} as { display_name?: string | null }));
  const updated = await taskStorage.updateTaskDisplayName(ctx, task.id, body.display_name ?? null);
  return c.json({ task: updated });
});

// PATCH /api/tasks/:id — update task properties (credential_id)
const EDITABLE_STATES = new Set(["paused", "cancelled", "failed", "completed"]);
tasksRouter.patch("/:id", async (c) => {
  const ctx = queryContextFromUser(c.get("user"));
  const task = await taskStorage.getTaskById(ctx, c.req.param("id"));
  if (!task) return c.json({ error: { code: "ERR_TASK_NOT_FOUND" } }, 404);
  if (!EDITABLE_STATES.has(task.state)) {
    return c.json({ error: { code: "ERR_INVALID_STATE", detail: `Cannot edit task in '${task.state}' state` } }, 409);
  }

  const body = await c.req.json<{ credential_id?: string | null }>();
  if (body.credential_id !== undefined) {
    // Validate credential exists (unless null = clear)
    if (body.credential_id !== null) {
      const creds = await listCredentials(ctx);
      if (!creds.find((cr) => cr.id === body.credential_id)) {
        return c.json({ error: { code: "ERR_NOT_FOUND", detail: "Credential not found" } }, 404);
      }
    }
    await taskStorage.updateTaskCredential(task.id, body.credential_id);
  }

  const updated = await taskStorage.getTaskById(ctx, task.id);
  return c.json(updated);
});

// DELETE /api/tasks/:id
tasksRouter.delete("/:id", async (c) => {
  const ctx = queryContextFromUser(c.get("user"));
  const task = await taskStorage.getTaskById(ctx, c.req.param("id"));
  if (!task) return c.json({ error: { code: "ERR_TASK_NOT_FOUND" } }, 404);
  if (["running", "queued"].includes(task.state)) {
    return c.json({ error: { code: "ERR_INTERNAL", detail: "Cancel or wait for task to finish before deleting" } }, 409);
  }

  const config = loadConfig();
  const minio = getMinio();

  // H2 §4 strict order: release the sandbox instance BEFORE deleting the task
  // record. A failed release leaves the mapping `releasing`; the reconciler
  // finishes it, so deletion is never blocked by a SandboxPlane outage.
  try {
    await releaseSandboxForTask(task.id);
  } catch (err) {
    logger.warn({ err, taskId: task.id }, "Sandbox release failed during delete; reconciler will finish it");
  }

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
  cleanupScanWorkDir(config.dataDir, task.id, config.docker.workerImage);

  return c.json({ ok: true });
});

// NOTE: POC routes moved to features/poc/routes.ts (pocRouter)
// Old GET /:id/poc and GET /:id/poc/:filename removed to avoid route conflict.

// GET /api/tasks/:id/events — live log events (archive + memory via event-archive)
tasksRouter.get("/:id/events", async (c) => {
  const ctx = queryContextFromUser(c.get("user"));
  const task = await taskStorage.getTaskById(ctx, c.req.param("id"));
  if (!task) return c.json({ error: { code: "ERR_TASK_NOT_FOUND" } }, 404);

  const source = c.req.query("source") ?? c.req.query("source_filter") ?? "all";
  const limitRaw = c.req.query("limit");
  const limit = limitRaw ? Math.min(Number(limitRaw), 5000) : undefined;

  const events = await loadTaskEvents({
    taskId: task.id,
    taskState: task.state,
    source,
    limit,
  });
  // total = monotonic count of all events ever produced (running/paused tasks
  // keep only the latest ~1000 in memory; total lets the UI show the true count
  // instead of resetting to the cap on refresh). Archived (terminal) states
  // return the full list, so length is the true total.
  const total = ["running", "paused"].includes(task.state)
    ? Math.max(getEventTotal(task.id), events.length)
    : events.length;
  return c.json({ events, total });
});
