/**
 * Report Skills routes — skills management + report generation/preview/download.
 */

import { Hono } from "hono";
import { requireAuth, requireAdmin } from "../../middleware/auth.js";
import { licenseGuard } from "../../middleware/license-guard.js";
import { loadConfig } from "../../infra/config.js";
import { uploadFile, getMinio } from "../../infra/minio/client.js";
import { logger } from "../../infra/logger.js";
import * as reportStorage from "./storage.js";
import { spawnReportWorker } from "./report-worker.js";

export const reportsRouter = new Hono();
reportsRouter.use("*", licenseGuard);
reportsRouter.use("*", requireAuth);

// ─── Skills CRUD (admin) ───

// GET /api/settings/skills
reportsRouter.get("/settings/skills", requireAdmin, async (c) => {
  const skills = await reportStorage.listSkills();
  return c.json({ skills });
});

// POST /api/settings/skills — upload skill zip
reportsRouter.post("/settings/skills", requireAdmin, async (c) => {
  const user = c.get("user");
  const formData = await c.req.formData();
  const file = formData.get("file") as File | null;
  if (!file) return c.json({ error: { code: "ERR_INTERNAL", detail: "file required" } }, 400);

  const maxBytes = 50 * 1024 * 1024; // 50MB
  if (file.size > maxBytes) {
    return c.json({ error: { code: "ERR_UPLOAD_TOO_LARGE" } }, 413);
  }

  const config = loadConfig();
  const name = formData.get("name") as string | null || file.name.replace(/\.zip$/i, "");
  const description = formData.get("description") as string | null || "";

  // Upload to MinIO
  const minioKey = `report-skills/${crypto.randomUUID()}.zip`;
  const buf = Buffer.from(await file.arrayBuffer());
  await uploadFile(config.minio.bucket, minioKey, buf, buf.length);

  // Count attachments (rudimentary: count entries in zip)
  let attachmentCount = 0;
  try {
    const { execSync } = await import("node:child_process");
    const output = execSync(`unzip -l /dev/stdin <<< "" 2>/dev/null | tail -1 || echo "0"`, {
      timeout: 5000, stdio: "pipe",
    }).toString();
    attachmentCount = parseInt(output) || 0;
  } catch { /* ok */ }

  const skill = await reportStorage.createSkill({
    name,
    description,
    minioKey,
    sizeBytes: file.size,
    attachmentCount,
    uploadedBy: user.userId,
  });

  return c.json({ skill }, 201);
});

// DELETE /api/settings/skills/:id
reportsRouter.delete("/settings/skills/:id", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const skill = await reportStorage.getSkill(id);
  if (!skill) return c.json({ error: { code: "ERR_NOT_FOUND" } }, 404);

  // Delete from MinIO
  const config = loadConfig();
  try {
    const minio = getMinio();
    await minio.removeObject(config.minio.bucket, skill.minio_key);
  } catch { /* best effort */ }

  await reportStorage.deleteSkill(id);
  return c.json({ ok: true });
});

// ─── Reports per task ───

// GET /api/tasks/:taskId/reports
reportsRouter.get("/tasks/:taskId/reports", async (c) => {
  const { taskId } = c.req.param();
  const reports = await reportStorage.listReports(taskId);
  return c.json({ reports });
});

// POST /api/tasks/:taskId/reports/generate
reportsRouter.post("/tasks/:taskId/reports/generate", async (c) => {
  const { taskId } = c.req.param();
  const user = c.get("user");

  try {
    const { assertNoActiveOperation } = await import("../tasks/operation-lock.js");
    await assertNoActiveOperation(taskId, "report");
  } catch (err: any) {
    if (err.code === "ERR_TASK_BUSY") return c.json({ error: { code: "ERR_TASK_BUSY", message: err.message, active: err.active } }, 409);
    throw err;
  }

  const body = await c.req.json<{ skill_id: string; credential_id?: string }>();

  if (!body.skill_id) {
    return c.json({ error: { code: "ERR_INTERNAL", detail: "skill_id required" } }, 400);
  }

  const config = loadConfig();

  // Create report record
  const report = await reportStorage.createReport({
    taskId,
    skillId: body.skill_id,
    createdBy: user.userId,
  });

  // Spawn report worker (async — don't block response)
  spawnReportWorker({
    taskId,
    reportId: report.id,
    skillId: body.skill_id,
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
    const content = Buffer.concat(chunks).toString("utf-8");

    const contentType = report.format === "html" ? "text/html"
      : report.format === "json" ? "application/json"
      : report.format === "pdf" ? "application/pdf"
      : "text/plain";

    return new Response(content, {
      headers: { "Content-Type": contentType },
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
