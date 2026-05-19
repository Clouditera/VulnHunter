/**
 * Sync worker outputs from bind-mount workDir to MinIO.
 * Called by scheduler after worker completes (before indexing).
 */

import { join, relative, sep } from "node:path";
import { readdirSync, existsSync } from "node:fs";
import { getMinio } from "../../infra/minio/client.js";
import { logger } from "../../infra/logger.js";
import { getHostWorkDir } from "./scan-worker.js";
import type { ServiceConfig } from "../../infra/config.js";

export async function syncOutputsToMinio(
  taskId: string,
  config: ServiceConfig,
): Promise<number> {
  const hostWorkDir = getHostWorkDir(config.dataDir, taskId);
  const outDir = join(hostWorkDir, "out");

  if (!existsSync(outDir)) {
    logger.debug({ taskId }, "No output directory to sync");
    return 0;
  }

  const minio = getMinio();
  const bucket = config.minio.bucket;
  const prefix = `scan-outputs/${taskId}/`;
  let synced = 0;

  function walkDir(dir: string): string[] {
    const results: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...walkDir(full));
      } else {
        results.push(full);
      }
    }
    return results;
  }

  function shouldSync(relPath: string): boolean {
    const normalized = relPath.split(sep).join("/");
    if (normalized.includes(".youngflow/checkpoints/")) return false;
    if (normalized.includes(".youngflow/sessions/")) return false;
    if (normalized.startsWith(".youngflow/logs/") && normalized !== ".youngflow/logs/youngflow.service.jsonl") return false;
    if (normalized.endsWith(".events.jsonl")) return false;
    return true;
  }

  const files = walkDir(outDir).filter((filePath) => shouldSync(relative(outDir, filePath)));
  for (const filePath of files) {
    const relPath = relative(outDir, filePath);
    const objectName = prefix + relPath;
    try {
      await minio.fPutObject(bucket, objectName, filePath);
      synced++;
    } catch (err) {
      logger.warn({ err, filePath, objectName }, "Failed to sync file to MinIO");
    }
  }

  logger.info({ taskId, synced, total: files.length }, "Outputs synced to MinIO");
  return synced;
}
