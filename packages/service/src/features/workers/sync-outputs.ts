/**
 * Sync worker outputs from bind-mount workDir to MinIO.
 * Called by scheduler after worker completes (before indexing).
 */

import { join, relative, dirname } from "node:path";
import { readdirSync, existsSync } from "node:fs";
import { getMinio } from "../../infra/minio/client.js";
import { logger } from "../../infra/logger.js";
import { getHostWorkDir } from "./scan-worker.js";
import { ensureWorkDir } from "./docker-client.js";
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

  const files = walkDir(outDir);
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

/**
 * Download historical scan outputs from MinIO back into the worker workspace.
 * Used by CONTINUE mode (the reverse of syncOutputsToMinio): VulnForge's
 * `--continue` needs the prior business artifacts (findings/risks/knowledge/
 * hypotheses/...) present in /workspace/out.
 *
 * Skips `.youngflow/sessions/` (LLM conversation logs, often GB-scale) — these
 * are not needed for --continue, which archives the old engine state and starts
 * a fresh run.
 */
export async function downloadOutputsFromMinio(
  taskId: string,
  config: ServiceConfig,
): Promise<number> {
  const hostWorkDir = getHostWorkDir(config.dataDir, taskId);
  const outDir = join(hostWorkDir, "out");
  ensureWorkDir(outDir);

  const minio = getMinio();
  const bucket = config.minio.bucket;
  const prefix = `scan-outputs/${taskId}/`;

  const keys = await new Promise<string[]>((resolve, reject) => {
    const acc: string[] = [];
    const stream = minio.listObjects(bucket, prefix, true);
    stream.on("data", (obj) => { if (obj.name) acc.push(obj.name); });
    stream.on("end", () => resolve(acc));
    stream.on("error", reject);
  });

  let downloaded = 0;
  for (const key of keys) {
    // Skip LLM conversation logs — not needed for --continue.
    if (key.includes(".youngflow/sessions/")) continue;
    const relPath = key.slice(prefix.length);
    if (!relPath) continue;
    const localPath = join(outDir, relPath);
    try {
      ensureWorkDir(dirname(localPath));
      await minio.fGetObject(bucket, key, localPath);
      downloaded++;
    } catch (err) {
      logger.warn({ err, key, localPath }, "Failed to download output for continue");
    }
  }

  logger.info({ taskId, downloaded, total: keys.length }, "Historical outputs downloaded for continue");
  return downloaded;
}
