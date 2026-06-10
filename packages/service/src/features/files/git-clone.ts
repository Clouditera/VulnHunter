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
import { updateTaskState, getTaskById } from "../tasks/storage.js";
import { appendEvent } from "../events/event-store.js";
import { logger } from "../../infra/logger.js";
import { statSync } from "node:fs";
import { getRemoteDefaultBranch, USER_REPO_UNREACHABLE, validateRemoteGitUrl } from "./git-remote.js";

const CLONE_TIMEOUT_MS = 600_000; // 10 min — large repos (e.g. 450MB) over constrained bandwidth
const ZIP_TIMEOUT_MS = 180_000;
const MAX_ATTEMPTS = 3;

/**
 * Emit a preparation-stage progress line into the task's Live Log ring buffer.
 * Service-side (no worker needed): renders as `task → <message>` in Live Log.
 * Used so users see "Cloning repository…" etc. during the `preparing` phase instead of
 * a silent "queued".
 */
export function emitPrepProgress(
  taskId: string,
  message: string,
  severity: "info" | "warning" | "error" = "info",
): void {
  try {
    appendEvent(taskId, {
      type: "task_status",
      source: "prepare",
      seq: 0, // ring buffer assigns the real seq
      ts: new Date().toISOString(),
      status: "running",
      reason: message,
      severity,
    });
  } catch (err) {
    logger.warn({ err, taskId }, "Failed to emit prep progress event");
  }
}

/** User-readable message for clone-stage failures (vs raw spawnSync stack). */
const USER_CLONE_FAILURE = "源码仓库较大或网络拥塞，拉取超时，请重试或改用上传 ZIP 压缩包的方式创建任务。";

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
  branch: string | undefined,
  bucket: string,
): Promise<void> {
  let lastErr: unknown = null;
  let unreachable = false;
  const safeGitUrl = validateRemoteGitUrl(gitUrl);
  const requestedBranch = branch?.trim() || undefined;
  let resolvedBranch = requestedBranch;
  if (!resolvedBranch) {
    try {
      resolvedBranch = (await getRemoteDefaultBranch(safeGitUrl)) ?? undefined;
    } catch (err) {
      logger.warn({ err, taskId, gitUrl }, "Failed to detect default git branch; falling back to git clone default");
    }
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const tmpDir = mkdtempSync(join(tmpdir(), `va-git-${taskId}-`));
    const repoDir = join(tmpDir, "repo");
    const zipPath = join(tmpDir, "source.zip");
    try {
      logger.info({ taskId, gitUrl, branch: resolvedBranch ?? "<remote-default>", attempt }, "Starting git clone");
      emitPrepProgress(
        taskId,
        attempt === 1 ? "Cloning repository…" : `Retrying clone (attempt ${attempt})…`,
      );

      // Shallow single-branch clone for speed. Async — does not block event loop.
      const cloneArgs = resolvedBranch
        ? ["clone", "--depth", "1", "--single-branch", "--branch", resolvedBranch, "--", safeGitUrl, repoDir]
        : ["clone", "--depth", "1", "--single-branch", "--", safeGitUrl, repoDir];
      await run("git", cloneArgs, { timeout: CLONE_TIMEOUT_MS });

      // Verify clone produced a non-empty working tree before zipping (guards half-clones).
      if (!existsSync(repoDir) || readdirSync(repoDir).length === 0) {
        throw new Error("clone produced empty working tree");
      }

      emitPrepProgress(taskId, "Packaging and uploading code…");
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
      // Code package is ready — leave `preparing`, enter `queued` so the
      // scheduler picks it up (queued now means "ready, waiting for a worker").
      // Guard against a concurrent cancel: only advance if still preparing.
      const cur = await getTaskById(taskId);
      if (cur && cur.state !== "preparing") {
        logger.info({ taskId, state: cur.state }, "Task no longer preparing (cancelled?), skipping queued transition");
        rmSync(tmpDir, { recursive: true, force: true });
        return;
      }
      emitPrepProgress(taskId, "Code ready, waiting for scheduler…");
      await updateTaskState(taskId, "queued");
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
  // Guard against a concurrent cancel: only fail if still preparing.
  const cur = await getTaskById(taskId);
  if (cur && cur.state !== "preparing") {
    logger.info({ taskId, state: cur.state }, "Task no longer preparing (cancelled?), skipping failed transition");
    return;
  }
  emitPrepProgress(
    taskId,
    unreachable ? USER_REPO_UNREACHABLE : USER_CLONE_FAILURE,
    "error",
  );
  await updateTaskState(taskId, "failed", {
    completedAt: new Date(),
    failureReason: unreachable ? USER_REPO_UNREACHABLE : USER_CLONE_FAILURE,
  });
}
