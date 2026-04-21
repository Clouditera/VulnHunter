/**
 * TaskScheduler: polls queued tasks every 5s, spawns workers up to max_parallel.
 * Also handles docker events (start/die/oom) to update task state.
 */

import { join } from "node:path";

import { execSync } from "node:child_process";
import { logger } from "../../infra/logger.js";
import { getDb } from "../../infra/db/client.js";
import { countTasksByState, getQueuedTasks, updateTaskState, type DbTask } from "../tasks/storage.js";
import { subscribeToDockerEvents, ensureWorkDir } from "./docker-client.js";
import { spawnScanWorker, getHostWorkDir } from "./scan-worker.js";
import { getDefaultCredential } from "../settings/storage.js";
import { startTailing, stopTailing } from "../events/event-tail.js";
import { indexFindings } from "../findings/indexer.js";
import { syncOutputsToMinio } from "./sync-outputs.js";
import { getMinio } from "../../infra/minio/client.js";
import type { ServiceConfig } from "../../infra/config.js";

export class TaskScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribeEvents: (() => void) | null = null;
  private maxParallelScan = 3;
  private config: ServiceConfig;

  constructor(config: ServiceConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    await this.refreshConfig();

    // Subscribe to docker events
    this.unsubscribeEvents = subscribeToDockerEvents(async (event) => {
      const { action, taskId, exitCode } = event;
      if (event.taskType !== "scan") return;

      logger.debug({ action, taskId, exitCode }, "Docker event");

      if (action === "die") {
        stopTailing(taskId);

        const ok = exitCode === 0;
        if (ok) {
          try {
            await syncOutputsToMinio(taskId, this.config);
          } catch (err) {
            logger.error({ err, taskId }, "Failed to sync outputs to MinIO");
          }
          try {
            const count = await indexFindings(taskId, this.config.minio.bucket);
            logger.info({ taskId, count }, "Findings indexed after scan completion");
          } catch (err) {
            logger.error({ err, taskId }, "Failed to index findings");
          }
        }

        const durationMs = await this.computeDuration(taskId);
        await updateTaskState(taskId, ok ? "completed" : "failed", {
          completedAt: new Date(),
          durationMs,
          failureReason: ok ? undefined : `Worker exited with code ${exitCode}`,
        }).catch((err) => logger.error({ err, taskId }, "Failed to update task on die"));
      }
    });

    // Start 5s tick
    this.timer = setInterval(
      () => this.tick().catch((err) => logger.error({ err }, "Scheduler tick error")),
      5000,
    );
    logger.info("TaskScheduler started");
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.unsubscribeEvents) this.unsubscribeEvents();
    logger.info("TaskScheduler stopped");
  }

  private async refreshConfig(): Promise<void> {
    try {
      const db = getDb();
      const rows = await db<{ config: { max_parallel_scan: number } }[]>`
        SELECT config FROM system_config WHERE id = 1
      `;
      if (rows[0]) {
        this.maxParallelScan = rows[0].config.max_parallel_scan;
      }
    } catch (err) {
      logger.warn({ err }, "Could not refresh system_config, using default max_parallel_scan=3");
    }
  }

  private async tick(): Promise<void> {
    await this.refreshConfig();
    const running = await countTasksByState("running");
    const capacity = this.maxParallelScan - running;

    if (capacity <= 0) return;

    const queued = await getQueuedTasks(capacity);
    if (queued.length === 0) return;

    // Get LLM credentials
    const cred = await getDefaultCredential();
    if (!cred) {
      logger.warn("No LLM credentials configured — skipping task scheduling");
      return;
    }

    const llmEnv: Record<string, string> = {
      MODEL_PROTO_TYPE: cred.proto_type,
      LLM_MODEL_NAME: cred.model_id,
      LLM_BASE_URL: cred.base_url ?? "",
      LLM_API_KEY: cred.api_key,
      MODEL_EFFORT: cred.thinking_effort ?? "off",
    };

    logger.info({ queued: queued.length, capacity }, "Scheduling queued tasks");

    for (const task of queued) {
      try {
        await this.prepareWorkspace(task);
        await spawnScanWorker(task, this.config, llmEnv);

        // Start tailing service event files
        const hostWorkDir = getHostWorkDir(this.config.dataDir, task.id);
        const eventsDir = join(hostWorkDir, "out", ".youngflow", "logs");
        startTailing(task.id, [], [{ path: eventsDir, source: "scan" }]);
      } catch (err) {
        logger.error({ err, taskId: task.id }, "Failed to spawn worker");
        await updateTaskState(task.id, "failed", {
          completedAt: new Date(),
          failureReason: String(err),
        });
      }
    }
  }

  private async prepareWorkspace(task: DbTask): Promise<void> {
    const hostWorkDir = getHostWorkDir(this.config.dataDir, task.id);
    const srcDir = join(hostWorkDir, "src");
    ensureWorkDir(srcDir);

    // Download code package from MinIO and extract
    const meta = task.source_meta as { minio_key?: string };
    const minioKey = meta?.minio_key ?? `code-packages/${task.id}.zip`;

    try {
      const minio = getMinio();
      const zipPath = join(hostWorkDir, "source.zip");
      await minio.fGetObject(this.config.minio.bucket, minioKey, zipPath);
      execSync(`cd "${srcDir}" && unzip -o -q "${zipPath}"`, { timeout: 60_000, stdio: "pipe" });
      logger.info({ taskId: task.id, minioKey }, "Code package extracted to workspace");
    } catch (err) {
      // If no code package (e.g. git clone still pending), just continue
      // Mock worker doesn't need source code
      logger.debug({ err, taskId: task.id }, "Could not extract code package (may be expected)");
    }
  }

  private async computeDuration(taskId: string): Promise<number | undefined> {
    try {
      const db = getDb();
      const rows = await db<{ started_at: Date | null }[]>`
        SELECT started_at FROM tasks WHERE id = ${taskId}
      `;
      if (rows[0]?.started_at) {
        return Date.now() - new Date(rows[0].started_at).getTime();
      }
    } catch {}
    return undefined;
  }
}
