/**
 * Git clone → zip → upload to MinIO.
 * Runs async after task creation (does not block HTTP response).
 */

import { mkdtempSync, rmSync, createReadStream, existsSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getMinio, uploadFile } from "../../infra/minio/client.js";
import { updateTaskState } from "../tasks/storage.js";
import { logger } from "../../infra/logger.js";
import { statSync } from "node:fs";

const CLONE_TIMEOUT_MS = 600_000; // 10 min — large repos (e.g. 450MB) over constrained bandwidth
const ZIP_TIMEOUT_MS = 180_000;
const MAX_ATTEMPTS = 3;

/** User-readable message for clone-stage failures (vs raw spawnSync stack). */
const USER_CLONE_FAILURE = "源码仓库较大或网络拥塞，拉取超时，请重试或改用上传 ZIP 压缩包的方式创建任务。";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function cloneAndUpload(
  taskId: string,
  gitUrl: string,
  branch: string,
  bucket: string,
): Promise<void> {
  let lastErr: unknown = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const tmpDir = mkdtempSync(join(tmpdir(), `va-git-${taskId}-`));
    const repoDir = join(tmpDir, "repo");
    const zipPath = join(tmpDir, "source.zip");
    try {
      logger.info({ taskId, gitUrl, branch, attempt }, "Starting git clone");

      // Shallow single-branch clone for speed. Clone failure throws (non-zero exit).
      execSync(
        `git clone --depth 1 --single-branch --branch "${branch}" "${gitUrl}" "${repoDir}"`,
        { timeout: CLONE_TIMEOUT_MS, stdio: "pipe" },
      );

      // Verify clone produced a non-empty working tree before zipping (guards half-clones).
      if (!existsSync(repoDir) || readdirSync(repoDir).length === 0) {
        throw new Error("clone produced empty working tree");
      }

      execSync(`cd "${repoDir}" && zip -r "${zipPath}" . -x '.git/*'`, {
        timeout: ZIP_TIMEOUT_MS,
        stdio: "pipe",
      });

      // Stream upload (avoids reading full zip into memory for large repos).
      const minioKey = `code-packages/${taskId}.zip`;
      const zipSize = statSync(zipPath).size;
      await uploadFile(bucket, minioKey, createReadStream(zipPath), zipSize);

      // Verify uploaded object size matches before declaring success.
      const stat = await getMinio().statObject(bucket, minioKey);
      if (stat.size !== zipSize) {
        throw new Error(`upload size mismatch: local ${zipSize} vs remote ${stat.size}`);
      }

      logger.info({ taskId, minioKey, size: zipSize, attempt }, "Git repo cloned and uploaded to MinIO");
      rmSync(tmpDir, { recursive: true, force: true });
      return;
    } catch (err) {
      lastErr = err;
      logger.warn({ err, taskId, gitUrl, attempt }, "Git clone attempt failed");
      rmSync(tmpDir, { recursive: true, force: true });
      if (attempt < MAX_ATTEMPTS) await sleep(attempt * 5_000); // exponential-ish backoff: 5s, 10s
    }
  }

  logger.error({ err: lastErr, taskId, gitUrl }, "Git clone failed after retries");
  await updateTaskState(taskId, "failed", {
    completedAt: new Date(),
    failureReason: USER_CLONE_FAILURE,
  });
}
