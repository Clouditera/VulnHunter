/**
 * Git clone → zip → upload to MinIO.
 * Runs async after task creation (does not block HTTP response).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { uploadFile } from "../../infra/minio/client.js";
import { updateTaskState } from "../tasks/storage.js";
import { logger } from "../../infra/logger.js";
import { readFileSync, statSync } from "node:fs";

export async function cloneAndUpload(
  taskId: string,
  gitUrl: string,
  branch: string,
  bucket: string,
): Promise<void> {
  const tmpDir = mkdtempSync(join(tmpdir(), `va-git-${taskId}-`));
  const repoDir = join(tmpDir, "repo");
  const zipPath = join(tmpDir, "source.zip");

  try {
    logger.info({ taskId, gitUrl, branch }, "Starting git clone");

    // Clone with depth 1 for speed
    execSync(
      `git clone --depth 1 --branch "${branch}" "${gitUrl}" "${repoDir}"`,
      { timeout: 120_000, stdio: "pipe" },
    );

    // Zip the repo (exclude .git)
    execSync(
      `cd "${repoDir}" && zip -r "${zipPath}" . -x '.git/*'`,
      { timeout: 60_000, stdio: "pipe" },
    );

    // Upload to MinIO
    const minioKey = `code-packages/${taskId}.zip`;
    const zipBuffer = readFileSync(zipPath);
    const zipSize = statSync(zipPath).size;
    await uploadFile(bucket, minioKey, zipBuffer, zipSize);

    logger.info({ taskId, minioKey, size: zipSize }, "Git repo cloned and uploaded to MinIO");
  } catch (err) {
    logger.error({ err, taskId, gitUrl }, "Git clone failed");
    await updateTaskState(taskId, "failed", {
      completedAt: new Date(),
      failureReason: `Git clone failed: ${String(err)}`,
    });
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}
