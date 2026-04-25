/**
 * Wiki Tab API — serves structured project knowledge from scan outputs.
 *
 * Running tasks: reads from local filesystem (dataDir/workspaces/<taskId>/out/)
 * Completed tasks: reads from MinIO (scan-outputs/<taskId>/)
 * Fallback: if primary source has no data, try the other source.
 */

import { Hono } from "hono";
import { requireAuth } from "../../middleware/auth.js";
import { licenseGuard } from "../../middleware/license-guard.js";
import { getTaskById } from "../tasks/storage.js";
import { getMinio } from "../../infra/minio/client.js";
import { loadConfig } from "../../infra/config.js";
import { logger } from "../../infra/logger.js";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

export const wikiRouter = new Hono();
wikiRouter.use("*", licenseGuard);
wikiRouter.use("*", requireAuth);

/* ── Local filesystem readers ── */

function readLocalText(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function listLocalFiles(dir: string, ext: string): string[] {
  try {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(ext))
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

/* ── MinIO readers ── */

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

/* ── Wiki data loader ── */

interface WikiData {
  profiler: unknown;
  reports: { name: string; format: string; content: string }[];
  features: unknown[];
  featureGroups: unknown[];
  analysisSummaries: unknown[];
}

function loadLocalWikiData(outDir: string): WikiData {
  // 1. Profiler
  const profilerRaw = readLocalText(join(outDir, "profiler", "project-profiler.yaml"));
  const profiler = profilerRaw ? yaml.load(profilerRaw) : null;

  // 2. Reports
  const reports: WikiData["reports"] = [];
  const aggMd = readLocalText(join(outDir, "aggregator", "aggregation-report.md"));
  if (aggMd) reports.push({ name: "aggregation-report", format: "md", content: aggMd });
  const secMd = readLocalText(join(outDir, "perspective_4_security", "security-mechanism-review.md"));
  if (secMd) reports.push({ name: "security-mechanism-review", format: "md", content: secMd });

  // 3. Features
  const features: unknown[] = [];
  for (const f of listLocalFiles(join(outDir, "aggregator", "aggregated_features"), ".yaml")) {
    const raw = readLocalText(f);
    if (raw) try { features.push(yaml.load(raw)); } catch { /* skip */ }
  }

  // 4. Feature groups
  const featureGroups: unknown[] = [];
  for (const f of listLocalFiles(join(outDir, "aggregator", "feature_groups"), ".yaml")) {
    const raw = readLocalText(f);
    if (raw) try { featureGroups.push(yaml.load(raw)); } catch { /* skip */ }
  }

  // 5. Analysis summaries
  const analysisSummaries: unknown[] = [];
  for (const f of listLocalFiles(join(outDir, "analysis_summaries"), ".yaml")) {
    const raw = readLocalText(f);
    if (raw) try { analysisSummaries.push(yaml.load(raw)); } catch { /* skip */ }
  }

  return { profiler, reports, features, featureGroups, analysisSummaries };
}

async function loadMinioWikiData(bucket: string, prefix: string): Promise<WikiData> {
  const profilerRaw = await readMinioText(bucket, `${prefix}profiler/project-profiler.yaml`);
  const profiler = profilerRaw ? yaml.load(profilerRaw) : null;

  const reports: WikiData["reports"] = [];
  const aggMd = await readMinioText(bucket, `${prefix}aggregator/aggregation-report.md`);
  if (aggMd) reports.push({ name: "aggregation-report", format: "md", content: aggMd });
  const secMd = await readMinioText(bucket, `${prefix}perspective_4_security/security-mechanism-review.md`);
  if (secMd) reports.push({ name: "security-mechanism-review", format: "md", content: secMd });

  const features: unknown[] = [];
  for (const key of (await listMinioKeys(bucket, `${prefix}aggregator/aggregated_features/`)).filter(k => k.endsWith(".yaml"))) {
    const raw = await readMinioText(bucket, key);
    if (raw) try { features.push(yaml.load(raw)); } catch { /* skip */ }
  }

  const featureGroups: unknown[] = [];
  for (const key of (await listMinioKeys(bucket, `${prefix}aggregator/feature_groups/`)).filter(k => k.endsWith(".yaml"))) {
    const raw = await readMinioText(bucket, key);
    if (raw) try { featureGroups.push(yaml.load(raw)); } catch { /* skip */ }
  }

  const analysisSummaries: unknown[] = [];
  for (const key of (await listMinioKeys(bucket, `${prefix}analysis_summaries/`)).filter(k => k.endsWith(".yaml"))) {
    const raw = await readMinioText(bucket, key);
    if (raw) try { analysisSummaries.push(yaml.load(raw)); } catch { /* skip */ }
  }

  return { profiler, reports, features, featureGroups, analysisSummaries };
}

function hasData(d: WikiData): boolean {
  return !!(d.profiler || d.reports.length || d.features.length || d.featureGroups.length || d.analysisSummaries.length);
}

function mergeWikiData(primary: WikiData, fallback: WikiData): WikiData {
  return {
    profiler: primary.profiler ?? fallback.profiler,
    reports: primary.reports.length > 0 ? primary.reports : fallback.reports,
    features: primary.features.length > 0 ? primary.features : fallback.features,
    featureGroups: primary.featureGroups.length > 0 ? primary.featureGroups : fallback.featureGroups,
    analysisSummaries: primary.analysisSummaries.length > 0 ? primary.analysisSummaries : fallback.analysisSummaries,
  };
}

// GET /api/tasks/:id/wiki
wikiRouter.get("/:id/wiki", async (c) => {
  const task = await getTaskById(c.req.param("id"));
  if (!task) return c.json({ error: { code: "ERR_TASK_NOT_FOUND" } }, 404);

  const config = loadConfig();
  const bucket = config.minio.bucket;
  const minioPrefix = `scan-outputs/${task.id}/`;
  const localOutDir = join(config.dataDir, "workspaces", task.id, "out");
  const isRunning = task.state === "running" || task.state === "paused";

  try {
    let data: WikiData;

    if (isRunning) {
      // Running: local first, fallback to MinIO
      const local = loadLocalWikiData(localOutDir);
      if (hasData(local)) {
        data = local;
      } else {
        const minio = await loadMinioWikiData(bucket, minioPrefix);
        data = mergeWikiData(local, minio);
      }
    } else {
      // Completed: MinIO first, fallback to local
      const minio = await loadMinioWikiData(bucket, minioPrefix);
      if (hasData(minio)) {
        data = minio;
      } else {
        const local = loadLocalWikiData(localOutDir);
        data = mergeWikiData(minio, local);
      }
    }

    return c.json(data);
  } catch (err) {
    logger.error({ err, taskId: task.id }, "Failed to load wiki data");
    return c.json({ error: { code: "ERR_INTERNAL", detail: String(err) } }, 500);
  }
});
