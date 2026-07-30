/**
 * Report Skills routes — user-level skills + report generation/preview/download.
 */

import { Hono } from "hono";
import { requireAuth } from "../../middleware/auth.js";
import { licenseGuard } from "../../middleware/license-guard.js";
import { loadConfig } from "../../infra/config.js";
import { withUtf8Charset } from "../../infra/http-text.js";
import { decodeTextFileContent } from "../source-archives/charset.js";
import { getMinio } from "../../infra/minio/client.js";
import { logger } from "../../infra/logger.js";
import { queryContextFromUser } from "../../infra/query-context.js";
import { getAccessibleTask } from "../tasks/access.js";
import * as reportStorage from "./storage.js";
import { spawnReportWorker } from "./report-worker.js";

export const reportsRouter = new Hono();
reportsRouter.use("*", async (c, next) => {
  if (c.req.path === "/api/system/activate") return next();
  return licenseGuard(c, next);
});
reportsRouter.use("*", async (c, next) => {
  if (c.req.path === "/api/system/activate") return next();
  return requireAuth(c, next);
});

// Skills CRUD moved to settings/routes.ts (Hono mount order)

// ─── Reports per task ───

// GET /api/tasks/:taskId/reports
reportsRouter.get("/tasks/:taskId/reports", async (c) => {
  const { taskId } = c.req.param();
  const task = await getAccessibleTask(queryContextFromUser(c.get("user")), taskId);
  if (!task) return c.json({ error: { code: "ERR_NOT_FOUND" } }, 404);
  const reports = await reportStorage.listReports(taskId);
  return c.json({ reports });
});

// POST /api/tasks/:taskId/reports/generate
reportsRouter.post("/tasks/:taskId/reports/generate", async (c) => {
  const { taskId } = c.req.param();
  const task = await getAccessibleTask(queryContextFromUser(c.get("user")), taskId);
  if (!task) return c.json({ error: { code: "ERR_NOT_FOUND" } }, 404);
  const user = c.get("user");

  try {
    const { assertNoActiveOperation } = await import("../tasks/operation-lock.js");
    await assertNoActiveOperation(taskId, "report");
  } catch (err: any) {
    if (err.code === "ERR_TASK_BUSY") return c.json({ error: { code: "ERR_TASK_BUSY", message: err.message, active: err.active } }, 409);
    throw err;
  }

  const body = await c.req.json<{ skill_id?: string | null; credential_id?: string; finding_keys?: string[] }>();

  // skill_id optional: empty/null → builtin default template
  let skillId: string | null = body.skill_id?.trim() || null;
  if (skillId) {
    const owned = await reportStorage.getOwnedSkill(skillId, user.userId);
    if (!owned) {
      return c.json({ error: { code: "ERR_VALIDATION", detail: "skill_id must refer to a skill you own" } }, 400);
    }
  }

  // If finding_keys explicitly empty array → reject
  if (body.finding_keys && body.finding_keys.length === 0) {
    return c.json({ error: { code: "ERR_VALIDATION", detail: "finding_keys cannot be empty when provided" } }, 400);
  }

  // If finding_keys not provided, default to pending + confirmed
  let findingKeys = body.finding_keys;
  if (!findingKeys) {
    const { listFindings } = await import("../findings/storage.js");
    const allFindings = await listFindings({ taskId, reviewStatuses: ["pending", "confirmed"], limit: 1000 });
    findingKeys = allFindings.map((f) => f.finding_key);
  }

  const config = loadConfig();

  // Create report record
  const report = await reportStorage.createReport({
    taskId,
    skillId,
    createdBy: user.userId,
  });

  // Spawn report worker (async — don't block response)
  spawnReportWorker({
    taskId,
    reportId: report.id,
    skillId,
    credentialId: body.credential_id,
    createdBy: user.userId,
    config,
  }).catch((err) => {
    logger.error({ err, reportId: report.id }, "Failed to spawn report worker");
    reportStorage.updateReportStatus(report.id, "failed", {
      failureReason: String(err),
    });
  });

  return c.json({ report }, 201);
});

// GET /api/tasks/:taskId/reports/:reportId
reportsRouter.get("/tasks/:taskId/reports/:reportId", async (c) => {
  const report = await reportStorage.getReport(c.req.param("reportId"));
  if (!report) return c.json({ error: { code: "ERR_NOT_FOUND" } }, 404);
  return c.json({ report });
});

// GET /api/tasks/:taskId/reports/:reportId/file — serve primary file for preview
reportsRouter.get("/tasks/:taskId/reports/:reportId/file", async (c) => {
  const report = await reportStorage.getReport(c.req.param("reportId"));
  if (!report || !report.primary_minio_key) {
    return c.json({ error: { code: "ERR_NOT_FOUND" } }, 404);
  }

  const config = loadConfig();
  const minio = getMinio();

  try {
    const stream = await minio.getObject(config.minio.bucket, report.primary_minio_key);
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", resolve);
      stream.on("error", reject);
    });
    const buf = Buffer.concat(chunks);
    const format = (report.format || "").toLowerCase();
    // Binary formats: stream raw bytes
    if (format === "pdf" || format === "docx" || format === "xlsx") {
      const binType =
        format === "pdf"
          ? "application/pdf"
          : format === "docx"
            ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      return new Response(buf, { headers: { "Content-Type": binType } });
    }

    const content = decodeTextFileContent(buf);
    const contentType =
      format === "html"
        ? "text/html"
        : format === "json"
          ? "application/json"
          : format === "md" || format === "markdown"
            ? "text/markdown"
            : "text/plain";

    return new Response(content, {
      headers: {
        "Content-Type": withUtf8Charset(contentType),
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return c.json({ error: { code: "ERR_NOT_FOUND" } }, 404);
  }
});

// GET /api/tasks/:taskId/reports/:reportId/download — download bundle
reportsRouter.get("/tasks/:taskId/reports/:reportId/download", async (c) => {
  const report = await reportStorage.getReport(c.req.param("reportId"));
  if (!report || !report.bundle_minio_key) {
    return c.json({ error: { code: "ERR_NOT_FOUND" } }, 404);
  }

  const config = loadConfig();
  const minio = getMinio();

  try {
    const stream = await minio.getObject(config.minio.bucket, report.bundle_minio_key);
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", resolve);
      stream.on("error", reject);
    });

    return new Response(Buffer.concat(chunks), {
      headers: {
        "Content-Type": "application/x-tar",
        "Content-Disposition": `attachment; filename="report-${report.id.slice(0, 8)}.tar"`,
      },
    });
  } catch {
    return c.json({ error: { code: "ERR_NOT_FOUND" } }, 404);
  }
});

// DELETE /api/tasks/:taskId/reports/:reportId
reportsRouter.delete("/tasks/:taskId/reports/:reportId", async (c) => {
  const report = await reportStorage.getReport(c.req.param("reportId"));
  if (!report) return c.json({ error: { code: "ERR_NOT_FOUND" } }, 404);

  const config = loadConfig();
  const minio = getMinio();

  // Clean MinIO (best effort)
  try {
    if (report.primary_minio_key) await minio.removeObject(config.minio.bucket, report.primary_minio_key);
    if (report.bundle_minio_key) await minio.removeObject(config.minio.bucket, report.bundle_minio_key);
  } catch { /* best effort */ }

  await reportStorage.deleteReport(report.id);
  return c.json({ ok: true });
});
