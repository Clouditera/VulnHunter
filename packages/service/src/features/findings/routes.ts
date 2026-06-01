import { Hono } from "hono";
import { load as yamlLoad } from "js-yaml";
import { requireAuth } from "../../middleware/auth.js";
import { licenseGuard } from "../../middleware/license-guard.js";
import {
  listFindings,
  getFindingByKey,
  setFindingReviewStatus,
  bulkSetFindingReviewStatus,
  listFindingReviewEvents,
  isFindingReviewStatus,
} from "./storage.js";
import { indexFindings } from "./indexer.js";
import { loadConfig } from "../../infra/config.js";
import { getMinio } from "../../infra/minio/client.js";
import { notify } from "../notifications/index.js";
import type { Severity, FindingReviewStatus } from "@vulnagent/shared";

export const findingsRouter = new Hono();
findingsRouter.use("*", licenseGuard);
findingsRouter.use("*", requireAuth);

// GET /api/tasks/:taskId/findings
findingsRouter.get("/:taskId/findings", async (c) => {
  const { taskId } = c.req.param();
  const severity = c.req.query("severity") as Severity | undefined;
  const search = c.req.query("search");
  const limit = Math.min(Number(c.req.query("limit") ?? 500), 1000);
  const offset = Number(c.req.query("offset") ?? 0);

  // Parse review_status filter (comma-separated)
  let reviewStatuses: FindingReviewStatus[] | undefined;
  const reviewParam = c.req.query("review_status");
  if (reviewParam) {
    const parts = reviewParam.split(",").map((s) => s.trim());
    const valid = parts.filter(isFindingReviewStatus);
    if (valid.length !== parts.length) {
      return c.json({ error: { code: "ERR_VALIDATION", message: "Invalid review_status value" } }, 400);
    }
    reviewStatuses = valid;
  }

  const findings = await listFindings({ taskId, severity, reviewStatuses, search, limit, offset });
  return c.json({ findings, total: findings.length });
});

// GET /api/tasks/:taskId/findings/:key  — full YAML detail
findingsRouter.get("/:taskId/findings/:key", async (c) => {
  const { taskId, key } = c.req.param();
  const config = loadConfig();

  const meta = await getFindingByKey(taskId, key);
  if (!meta) return c.json({ error: { code: "ERR_NOT_FOUND" } }, 404);

  // Fetch and parse YAML from MinIO
  const minio = getMinio();
  const stream = await minio.getObject(config.minio.bucket, meta.yaml_minio_key);
  const raw = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    stream.on("error", reject);
  });

  const parsed = yamlLoad(raw);
  return c.json({ meta, detail: parsed });
});

// PATCH /api/tasks/:taskId/findings/:key/review — single review
findingsRouter.patch("/:taskId/findings/:key/review", async (c) => {
  const { taskId, key } = c.req.param();
  const user = c.get("user");
  const body = await c.req.json<{ review_status: string; note?: string }>();

  if (!body.review_status || !isFindingReviewStatus(body.review_status)) {
    return c.json({ error: { code: "ERR_VALIDATION", message: "Invalid review_status" } }, 400);
  }

  try {
    const result = await setFindingReviewStatus({
      taskId,
      findingKey: key,
      userId: user.userId,
      reviewStatus: body.review_status,
      note: body.note,
    });

    // Notify SSE
    notify({
      type: "finding_review_updated",
      taskId,
      findingKeys: [key],
      reviewStatus: body.review_status,
    });

    return c.json({ finding: result.finding, event: result.event });
  } catch (err: any) {
    if (err.code === "ERR_NOT_FOUND") {
      return c.json({ error: { code: "ERR_NOT_FOUND" } }, 404);
    }
    throw err;
  }
});

// POST /api/tasks/:taskId/findings/review/bulk — bulk review
findingsRouter.post("/:taskId/findings/review/bulk", async (c) => {
  const { taskId } = c.req.param();
  const user = c.get("user");
  const body = await c.req.json<{ finding_keys: string[]; review_status: string; note?: string }>();

  if (!body.finding_keys || !Array.isArray(body.finding_keys) || body.finding_keys.length === 0) {
    return c.json({ error: { code: "ERR_VALIDATION", message: "finding_keys required" } }, 400);
  }
  if (!body.review_status || !isFindingReviewStatus(body.review_status)) {
    return c.json({ error: { code: "ERR_VALIDATION", message: "Invalid review_status" } }, 400);
  }

  try {
    const result = await bulkSetFindingReviewStatus({
      taskId,
      findingKeys: body.finding_keys,
      userId: user.userId,
      reviewStatus: body.review_status,
      note: body.note,
    });

    notify({
      type: "finding_review_updated",
      taskId,
      findingKeys: body.finding_keys,
      reviewStatus: body.review_status,
    });

    return c.json({ updated: result.updated, findings: result.findings });
  } catch (err: any) {
    if (err.code === "ERR_VALIDATION") {
      return c.json({ error: { code: "ERR_VALIDATION", message: err.message } }, 400);
    }
    throw err;
  }
});

// GET /api/tasks/:taskId/findings/:key/review-events — audit history
findingsRouter.get("/:taskId/findings/:key/review-events", async (c) => {
  const { taskId, key } = c.req.param();
  const events = await listFindingReviewEvents(taskId, key);
  return c.json({ events });
});

// POST /api/tasks/:taskId/findings/reindex  — (admin only in production)
findingsRouter.post("/:taskId/findings/reindex", async (c) => {
  const { taskId } = c.req.param();
  const config = loadConfig();

  const indexed = await indexFindings(taskId, config.minio.bucket);
  return c.json({ indexed });
});
