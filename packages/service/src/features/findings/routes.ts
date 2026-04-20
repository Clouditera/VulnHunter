import { Hono } from "hono";
import { load as yamlLoad } from "js-yaml";
import { requireAuth } from "../../middleware/auth.js";
import { licenseGuard } from "../../middleware/license-guard.js";
import { listFindings, getFindingByKey } from "./storage.js";
import { indexFindings } from "./indexer.js";
import { loadConfig } from "../../infra/config.js";
import { getMinio } from "../../infra/minio/client.js";
import type { Severity } from "@vulnhunt/shared";

export const findingsRouter = new Hono();
findingsRouter.use("*", licenseGuard);
findingsRouter.use("*", requireAuth);

// GET /api/tasks/:taskId/findings
findingsRouter.get("/:taskId/findings", async (c) => {
  const { taskId } = c.req.param();
  const severity = c.req.query("severity") as Severity | undefined;
  const search = c.req.query("search");
  const limit = Math.min(Number(c.req.query("limit") ?? 100), 200);
  const offset = Number(c.req.query("offset") ?? 0);

  const findings = await listFindings({ taskId, severity, search, limit, offset });
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

// POST /api/tasks/:taskId/findings/reindex  — (admin only in production)
findingsRouter.post("/:taskId/findings/reindex", async (c) => {
  const { taskId } = c.req.param();
  const config = loadConfig();

  const indexed = await indexFindings(taskId, config.minio.bucket);
  return c.json({ indexed });
});
