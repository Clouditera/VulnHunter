/**
 * Git clone → zip → upload to MinIO.
 * Runs async after task creation (does not block HTTP response).
 *
 * All shell-outs use async execFile/spawn so the clone (which can run for
 * minutes on large repos) never blocks the Node event loop — a blocking
 * execSync here would freeze the whole service for every user.
 */

import { mkdtempSync, rmSync, createReadStream, existsSync, readdirSync } from "node:fs";
import { execFile } from "node:child_process";
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
const USER_REPO_UNREACHABLE = "无法访问该源码仓库，请检查仓库地址和分支是否正确，或改用上传 ZIP 压缩包的方式创建任务。";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Async exec that yields the event loop. stdout/stderr captured; non-zero rejects. */
function run(cmd: string, args: string[], opts: { timeout: number; cwd?: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: opts.timeout, cwd: opts.cwd, maxBuffer: 64 * 1024 * 1024 }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

/** Auth / not-found / bad-branch failures won't succeed on retry — don't re-clone 450MB. */
function isNonRetryable(err: unknown): boolean {
  const s = String((err as { stderr?: string })?.stderr ?? err);
  return /not found|repository not found|could not read|authentication|access denied|remote branch .* not found|does not exist/i.test(s);
}

export async function cloneAndUpload(
  taskId: string,
  gitUrl: string,
  branch: string,
  bucket: string,
): Promise<void> {
  let lastErr: unknown = null;
  let unreachable = false;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const tmpDir = mkdtempSync(join(tmpdir(), `va-git-${taskId}-`));
    const repoDir = join(tmpDir, "repo");
    const zipPath = join(tmpDir, "source.zip");
    try {
      logger.info({ taskId, gitUrl, branch, attempt }, "Starting git clone");

      // Shallow single-branch clone for speed. Async — does not block event loop.
      await run("git", ["clone", "--depth", "1", "--single-branch", "--branch", branch, gitUrl, repoDir], {
        timeout: CLONE_TIMEOUT_MS,
      });

      // Verify clone produced a non-empty working tree before zipping (guards half-clones).
      if (!existsSync(repoDir) || readdirSync(repoDir).length === 0) {
        throw new Error("clone produced empty working tree");
      }

      await run("zip", ["-r", zipPath, ".", "-x", ".git/*"], { timeout: ZIP_TIMEOUT_MS, cwd: repoDir });

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
      rmSync(tmpDir, { recursive: true, force: true });
      if (isNonRetryable(err)) {
        unreachable = true;
        logger.warn({ err, taskId, gitUrl, attempt }, "Git clone failed (non-retryable), aborting");
        break;
      }
      logger.warn({ err, taskId, gitUrl, attempt }, "Git clone attempt failed");
      if (attempt < MAX_ATTEMPTS) await sleep(attempt * 5_000); // backoff: 5s, 10s
    }
  }

  logger.error({ err: lastErr, taskId, gitUrl }, "Git clone failed");
  await updateTaskState(taskId, "failed", {
    completedAt: new Date(),
    failureReason: unreachable ? USER_REPO_UNREACHABLE : USER_CLONE_FAILURE,
  });
}
