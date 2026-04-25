/**
 * POC/EXP generation routes — generate, view, re-run POC scripts.
 */

import { Hono } from "hono";
import { requireAuth } from "../../middleware/auth.js";
import { licenseGuard } from "../../middleware/license-guard.js";
import { loadConfig } from "../../infra/config.js";
import { getMinio } from "../../infra/minio/client.js";
import { logger } from "../../infra/logger.js";
import { assertNoActiveOperation } from "../tasks/operation-lock.js";
import * as pocStorage from "./storage.js";
import * as taskStorage from "../tasks/storage.js";

export const pocRouter = new Hono();
pocRouter.use("*", licenseGuard);
pocRouter.use("*", requireAuth);

// ─── POC Summary ───

// GET /api/tasks/:taskId/poc — per-finding POC status list
pocRouter.get("/:taskId/poc", async (c) => {
  const taskId = c.req.param("taskId");
  const task = await taskStorage.getTaskById(taskId);
  if (!task) return c.json({ error: { code: "ERR_NOT_FOUND" } }, 404);

  const results = await pocStorage.listPocResults(taskId);
  const jobs = await pocStorage.listPocJobs(taskId);
  const latestJob = jobs[0] ?? null;

  return c.json({
    results,
    latest_job: latestJob,
    summary: {
      total: results.length,
      reproduced: results.filter((r) => r.status === "reproduced").length,
      partial: results.filter((r) => r.status === "partial").length,
      not_reproduced: results.filter((r) => r.status === "not_reproduced").length,
      error: results.filter((r) => r.status === "error").length,
      skipped: results.filter((r) => r.status === "skipped").length,
      pending: results.filter((r) => r.status === "pending").length,
    },
  });
});

// ─── Generate POC ───

// POST /api/tasks/:taskId/poc/generate
pocRouter.post("/:taskId/poc/generate", async (c) => {
  const taskId = c.req.param("taskId");
  const user = c.get("user");
  const task = await taskStorage.getTaskById(taskId);
  if (!task) return c.json({ error: { code: "ERR_NOT_FOUND" } }, 404);

  try { await assertNoActiveOperation(taskId, "poc"); } catch (err: any) {
    if (err.code === "ERR_TASK_BUSY") return c.json({ error: { code: "ERR_TASK_BUSY", message: err.message, active: err.active } }, 409);
    throw err;
  }

  const body = await c.req.json<{
    finding_keys: string[];
    target_mode: string;
    target_url?: string;
    custom_instructions?: string;
    browser_tool?: string;
    credential_id?: string;
    deveye_server?: string;
    deveye_token?: string;
  }>();

  if (!body.finding_keys || body.finding_keys.length === 0) {
    return c.json({ error: { code: "ERR_VALIDATION", message: "finding_keys required" } }, 400);
  }

  if (!body.target_mode || !["provided", "auto_deploy"].includes(body.target_mode)) {
    return c.json({ error: { code: "ERR_VALIDATION", message: "target_mode must be 'provided' or 'auto_deploy'" } }, 400);
  }

  if (body.target_mode === "provided" && !body.target_url) {
    return c.json({ error: { code: "ERR_VALIDATION", message: "target_url required for provided mode" } }, 400);
  }

  const job = await pocStorage.createPocJob({
    taskId,
    targetMode: body.target_mode,
    targetUrl: body.target_url,
    customInstructions: body.custom_instructions,
    browserTool: body.browser_tool,
    findingKeys: body.finding_keys,
    createdBy: user.userId,
    deveyeServer: body.deveye_server,
    deveyeToken: body.deveye_token,
  });

  // Create pending results for each finding (will be upserted on completion)
  for (const key of body.finding_keys) {
    await pocStorage.upsertPocResult({
      taskId,
      jobId: job.id,
      findingKey: key,
      status: "pending",
      targetUrl: body.target_url,
    });
  }

  logger.info({ jobId: job.id, taskId, findings: body.finding_keys.length }, "POC job created");

  return c.json({ job }, 201);
});

// ─── Job Status ───

// GET /api/tasks/:taskId/poc/jobs/:jobId
pocRouter.get("/:taskId/poc/jobs/:jobId", async (c) => {
  const job = await pocStorage.getPocJob(c.req.param("jobId"));
  if (!job || job.task_id !== c.req.param("taskId")) {
    return c.json({ error: { code: "ERR_NOT_FOUND" } }, 404);
  }
  return c.json({ job });
});

// ─── Single Finding POC Detail ───

// GET /api/tasks/:taskId/poc/:findingKey
pocRouter.get("/:taskId/poc/:findingKey", async (c) => {
  const taskId = c.req.param("taskId");
  const findingKey = c.req.param("findingKey");

  // Avoid matching "jobs", "generate" etc as findingKey
  if (["jobs", "generate"].includes(findingKey)) return c.notFound();

  const result = await pocStorage.getPocResult(taskId, findingKey);
  if (!result) return c.json({ error: { code: "ERR_NOT_FOUND" } }, 404);

  const runs = await pocStorage.listPocRuns(taskId, findingKey);

  // List actual screenshot files from MinIO
  let screenshots: string[] = [];
  if (result.screenshots_prefix) {
    try {
      const config = loadConfig();
      const minio = getMinio();
      const stream = minio.listObjects(config.minio.bucket, result.screenshots_prefix, false);
      await new Promise<void>((resolve, reject) => {
        stream.on("data", (obj) => {
          if (obj.name) {
            const name = obj.name.split("/").pop();
            if (name && (name.endsWith(".png") || name.endsWith(".jpg") || name.endsWith(".jpeg"))) {
              screenshots.push(name);
            }
          }
        });
        stream.on("end", resolve);
        stream.on("error", reject);
      });
    } catch { /* no screenshots */ }
  }

  return c.json({ result, runs, screenshots });
});

// ─── Download POC Script ───

// GET /api/tasks/:taskId/poc/:findingKey/script
pocRouter.get("/:taskId/poc/:findingKey/script", async (c) => {
  const result = await pocStorage.getPocResult(c.req.param("taskId"), c.req.param("findingKey"));
  if (!result?.poc_script_minio_key) {
    return c.json({ error: { code: "ERR_NOT_FOUND" } }, 404);
  }

  const config = loadConfig();
  const minio = getMinio();
  const stream = await minio.getObject(config.minio.bucket, result.poc_script_minio_key);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  const content = Buffer.concat(chunks).toString("utf-8");

  return c.text(content, 200, {
    "Content-Type": "text/x-shellscript",
    "Content-Disposition": `attachment; filename="${result.finding_key}-poc.sh"`,
  });
});

// ─── Download Run Log ───

// GET /api/tasks/:taskId/poc/:findingKey/log
pocRouter.get("/:taskId/poc/:findingKey/log", async (c) => {
  const result = await pocStorage.getPocResult(c.req.param("taskId"), c.req.param("findingKey"));
  if (!result?.run_log_minio_key) {
    return c.json({ error: { code: "ERR_NOT_FOUND" } }, 404);
  }

  const config = loadConfig();
  const minio = getMinio();
  const stream = await minio.getObject(config.minio.bucket, result.run_log_minio_key);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  const content = Buffer.concat(chunks).toString("utf-8");

  return c.text(content);
});

// ─── Screenshots ───

// GET /api/tasks/:taskId/poc/:findingKey/screenshots/:name
pocRouter.get("/:taskId/poc/:findingKey/screenshots/:name", async (c) => {
  const result = await pocStorage.getPocResult(c.req.param("taskId"), c.req.param("findingKey"));
  if (!result?.screenshots_prefix) {
    return c.json({ error: { code: "ERR_NOT_FOUND" } }, 404);
  }

  const config = loadConfig();
  const minio = getMinio();
  const key = `${result.screenshots_prefix}${c.req.param("name")}`;

  try {
    const stream = await minio.getObject(config.minio.bucket, key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    const buf = Buffer.concat(chunks);

    const name = c.req.param("name");
    const contentType = name.endsWith(".png") ? "image/png" : name.endsWith(".jpg") ? "image/jpeg" : "application/octet-stream";
    return c.body(buf, 200, { "Content-Type": contentType });
  } catch {
    return c.json({ error: { code: "ERR_NOT_FOUND" } }, 404);
  }
});

// ─── Run Again ───

// POST /api/tasks/:taskId/poc/:findingKey/run
pocRouter.post("/:taskId/poc/:findingKey/run", async (c) => {
  const taskId = c.req.param("taskId");
  const findingKey = c.req.param("findingKey");
  const user = c.get("user");

  try { await assertNoActiveOperation(taskId, "poc"); } catch (err: any) {
    if (err.code === "ERR_TASK_BUSY") return c.json({ error: { code: "ERR_TASK_BUSY", message: err.message, active: err.active } }, 409);
    throw err;
  }

  const result = await pocStorage.getPocResult(taskId, findingKey);
  if (!result) {
    return c.json({ error: { code: "ERR_NOT_FOUND", message: "No POC result for this finding" } }, 404);
  }

  if (!result.poc_script_minio_key) {
    return c.json({ error: { code: "ERR_VALIDATION", message: "No POC script available" } }, 400);
  }

  const body = await c.req.json<{
    target_url?: string;
    custom_instructions?: string;
  }>();

  const run = await pocStorage.createPocRun({
    taskId,
    findingKey,
    resultId: result.id,
    targetUrl: body.target_url ?? result.target_url ?? undefined,
    customInstructions: body.custom_instructions,
    createdBy: user.userId,
  });

  logger.info({ runId: run.id, taskId, findingKey }, "POC run created");

  return c.json({ run }, 201);
});

// GET /api/tasks/:taskId/poc/:findingKey/runs
pocRouter.get("/:taskId/poc/:findingKey/runs", async (c) => {
  const runs = await pocStorage.listPocRuns(c.req.param("taskId"), c.req.param("findingKey"));
  return c.json({ runs });
});

// GET /api/tasks/:taskId/poc/:findingKey/runs/:runId
pocRouter.get("/:taskId/poc/:findingKey/runs/:runId", async (c) => {
  const run = await pocStorage.getPocRun(c.req.param("runId"));
  if (!run || run.task_id !== c.req.param("taskId") || run.finding_key !== c.req.param("findingKey")) {
    return c.json({ error: { code: "ERR_NOT_FOUND" } }, 404);
  }
  return c.json({ run });
});
