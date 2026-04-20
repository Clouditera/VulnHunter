/**
 * TaskScheduler: polls queued tasks every 5s, spawns workers up to max_parallel.
 * Also handles docker events (start/die/oom) to update task state.
 */

import { logger } from "../../infra/logger.js";
import { getDb } from "../../infra/db/client.js";
import { countTasksByState, getQueuedTasks, updateTaskState } from "../tasks/storage.js";
import { subscribeToDockerEvents } from "./docker-client.js";
import type { ServiceConfig } from "../../infra/config.js";

export class TaskScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribeEvents: (() => void) | null = null;
  private maxParallelScan = 3;

  constructor(config: ServiceConfig) {
    void config; // reserved for future worker spawn
  }

  async start(): Promise<void> {
    // Load max_parallel from system_config
    await this.refreshConfig();

    // Subscribe to docker events
    this.unsubscribeEvents = subscribeToDockerEvents(async (event) => {
      const { action, taskId, exitCode } = event;
      if (event.taskType !== "scan") return; // only handle scan workers here

      logger.debug({ action, taskId, exitCode }, "Docker event");

      if (action === "die") {
        const ok = exitCode === 0;
        await updateTaskState(taskId, ok ? "completed" : "failed", {
          completedAt: new Date(),
          failureReason: ok ? undefined : `Worker exited with code ${exitCode}`,
        }).catch((err) => logger.error({ err, taskId }, "Failed to update task on die"));
      }
    });

    // Start 5s tick
    this.timer = setInterval(() => this.tick().catch((err) => logger.error({ err }, "Scheduler tick error")), 5000);
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

    logger.info({ queued: queued.length, capacity }, "Scheduling queued tasks");

    for (const task of queued) {
      try {
        // TODO: pass actual LLM credentials here (Phase 2 follow-up)
        // For now, log that we would spawn
        logger.info({ taskId: task.id }, "Would spawn scan worker (LLM creds not wired yet)");
        // await spawnScanWorker(task, this.config, llmEnv);
      } catch (err) {
        logger.error({ err, taskId: task.id }, "Failed to spawn worker");
        await updateTaskState(task.id, "failed", {
          completedAt: new Date(),
          failureReason: String(err),
        });
      }
    }
  }
}
