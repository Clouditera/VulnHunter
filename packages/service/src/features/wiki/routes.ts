/**
 * Wiki Tab API — serves structured project knowledge from scan outputs.
 * Reads profiler YAML, aggregation reports (MD), feature cards (YAML),
 * and feature groups (YAML) from MinIO scan-outputs/<taskId>/.
 */

import { Hono } from "hono";
import { requireAuth } from "../../middleware/auth.js";
import { licenseGuard } from "../../middleware/license-guard.js";
import { getTaskById } from "../tasks/storage.js";
import { getMinio } from "../../infra/minio/client.js";
import { loadConfig } from "../../infra/config.js";
import { logger } from "../../infra/logger.js";
import yaml from "js-yaml";

export const wikiRouter = new Hono();
wikiRouter.use("*", licenseGuard);
wikiRouter.use("*", requireAuth);

/** Read a single object from MinIO as string. Returns null if not found. */
async function readMinioText(bucket: string, key: string): Promise<string | null> {
  try {
    const minio = getMinio();
    const stream = await minio.getObject(bucket, key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf-8");
  } catch {
    return null;
  }
}

/** List objects under a MinIO prefix */
async function listMinioKeys(bucket: string, prefix: string): Promise<string[]> {
  const minio = getMinio();
  return new Promise((resolve, reject) => {
    const keys: string[] = [];
    const stream = minio.listObjects(bucket, prefix, true);
    stream.on("data", (obj) => { if (obj.name) keys.push(obj.name); });
    stream.on("end", () => resolve(keys));
    stream.on("error", reject);
  });
}

// GET /api/tasks/:id/wiki
wikiRouter.get("/:id/wiki", async (c) => {
  const task = await getTaskById(c.req.param("id"));
  if (!task) return c.json({ error: { code: "ERR_TASK_NOT_FOUND" } }, 404);

  const config = loadConfig();
  const bucket = config.minio.bucket;
  const prefix = `scan-outputs/${task.id}/`;

  try {
    // 1. Profiler YAML
    const profilerRaw = await readMinioText(bucket, `${prefix}profiler/project-profiler.yaml`);
    const profiler = profilerRaw ? yaml.load(profilerRaw) : null;

    // 2. Markdown reports (aggregation + security mechanism review)
    const reports: { name: string; format: string; content: string }[] = [];

    const aggregationMd = await readMinioText(bucket, `${prefix}aggregator/aggregation-report.md`);
    if (aggregationMd) reports.push({ name: "aggregation-report", format: "md", content: aggregationMd });

    const securityMd = await readMinioText(bucket, `${prefix}perspective_4_security/security-mechanism-review.md`);
    if (securityMd) reports.push({ name: "security-mechanism-review", format: "md", content: securityMd });

    // 3. Feature cards (aggregated_features/*.yaml)
    const featureKeys = await listMinioKeys(bucket, `${prefix}aggregator/aggregated_features/`);
    const features: unknown[] = [];
    for (const key of featureKeys.filter(k => k.endsWith(".yaml"))) {
      const raw = await readMinioText(bucket, key);
      if (raw) {
        try {
          features.push(yaml.load(raw));
        } catch { /* skip malformed */ }
      }
    }

    // 4. Feature groups (feature_groups/*.yaml)
    const groupKeys = await listMinioKeys(bucket, `${prefix}aggregator/feature_groups/`);
    const featureGroups: unknown[] = [];
    for (const key of groupKeys.filter(k => k.endsWith(".yaml"))) {
      const raw = await readMinioText(bucket, key);
      if (raw) {
        try {
          featureGroups.push(yaml.load(raw));
        } catch { /* skip malformed */ }
      }
    }

    // 5. Analysis summaries (analysis_summaries/*.yaml)
    const summaryKeys = await listMinioKeys(bucket, `${prefix}analysis_summaries/`);
    const analysisSummaries: unknown[] = [];
    for (const key of summaryKeys.filter(k => k.endsWith(".yaml"))) {
      const raw = await readMinioText(bucket, key);
      if (raw) {
        try {
          analysisSummaries.push(yaml.load(raw));
        } catch { /* skip malformed */ }
      }
    }

    return c.json({
      profiler,
      reports,
      features,
      featureGroups,
      analysisSummaries,
    });
  } catch (err) {
    logger.error({ err, taskId: task.id }, "Failed to load wiki data");
    return c.json({ error: { code: "ERR_INTERNAL", detail: String(err) } }, 500);
  }
});
