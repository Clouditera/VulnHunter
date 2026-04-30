/**
 * TaskScheduler: polls queued tasks every 5s, spawns workers up to max_parallel.
 * Also handles docker events (start/die/oom) to update task state.
 */

import { join } from "node:path";
import { readFileSync } from "node:fs";
import { load as yamlLoad } from "js-yaml";

import { execSync } from "node:child_process";
import { logger } from "../../infra/logger.js";
import { getDb } from "../../infra/db/client.js";
import { countTasksByState, getQueuedTasks, getTaskById, updateTaskState, type DbTask } from "../tasks/storage.js";
import { subscribeToDockerEvents, ensureWorkDir } from "./docker-client.js";
import { spawnScanWorker, getHostWorkDir } from "./scan-worker.js";
import { getDefaultCredential, getCredentialById } from "../settings/storage.js";
import { CredentialDecryptError, CredentialKeyUnavailableError } from "../../infra/crypto/master-key-vault.js";
import { credentialToWorkerEnv } from "../settings/credential-env.js";
import { startTailing, stopTailing } from "../events/event-tail.js";
import { indexFindings } from "../findings/indexer.js";
import { syncOutputsToMinio } from "./sync-outputs.js";
import { getMinio } from "../../infra/minio/client.js";
import { onChatContainerDie } from "../chat/chat-session.js";
import { onReportContainerDie } from "../reports/report-worker.js";
import { onEvalContainerDie, onPocRunContainerDie, tickPocScheduler } from "../poc/scheduler.js";
import { notify } from "../notifications/index.js";
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

      // Chat container lifecycle — event-driven state transition
      if (event.taskType === "chat" && action === "die") {
        onChatContainerDie(taskId);
        return;
      }

      // Report container lifecycle — one-shot completion
      if (event.taskType === "report" && action === "die") {
        onReportContainerDie(taskId, exitCode).catch((err) =>
          logger.error({ err, taskId }, "Failed to handle report container die"),
        );
        return;
      }

      // Eval container lifecycle — POC generation
      if (event.taskType === "eval" && action === "die") {
        stopTailing(taskId);
        onEvalContainerDie(taskId, exitCode, this.config).catch((err) =>
          logger.error({ err, taskId }, "Failed to handle eval container die"),
        );
        return;
      }

      // POC run container lifecycle — lightweight re-execution
      if (event.taskType === "poc-run" && action === "die") {
        stopTailing(taskId);
        onPocRunContainerDie(taskId, exitCode, this.config).catch((err) =>
          logger.error({ err, taskId }, "Failed to handle poc-run container die"),
        );
        return;
      }

      if (event.taskType !== "scan") return;

      logger.debug({ action, taskId, exitCode }, "Docker event");

      if (action === "die") {
        stopTailing(taskId);

        // Check current DB state — if already cancelled/paused, don't overwrite
        const currentTask = await getTaskById(taskId);
        if (currentTask && ["cancelled", "paused"].includes(currentTask.state)) {
          logger.info({ taskId, dbState: currentTask.state, exitCode }, "Container died but task already cancelled/paused, skipping state update");
          // Still sync outputs for cancelled tasks (may have partial results)
          if (currentTask.state === "cancelled") {
            try {
              await syncOutputsToMinio(taskId, this.config);
            } catch (err) {
              logger.warn({ err, taskId }, "Failed to sync outputs on cancel");
            }
          }
        } else {
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
              notify({ type: "findings_indexed", taskId, count });
            } catch (err) {
              logger.error({ err, taskId }, "Failed to index findings");
            }
            // Extract profiler + execution metadata
            try {
              await this.extractMetadata(taskId);
            } catch (err) {
              logger.warn({ err, taskId }, "Failed to extract task metadata");
            }
          }

          const durationMs = await this.computeDuration(taskId);
          const newState = ok ? "completed" : "failed";
          await updateTaskState(taskId, newState, {
            completedAt: new Date(),
            durationMs,
            failureReason: ok ? undefined : `Worker exited with code ${exitCode}`,
          }).catch((err) => logger.error({ err, taskId }, "Failed to update task on die"));
          notify({ type: "task_state", taskId, state: newState as import("@vulnhunt/shared").TaskState });
        }
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
        this.maxParallelScan = Number(rows[0].config.max_parallel_scan) || 3;
      }
    } catch (err) {
      logger.warn({ err }, "Could not refresh system_config, using default max_parallel_scan=3");
    }
  }

  private async tick(): Promise<void> {
    await this.refreshConfig();

    // POC job/run scheduling
    await tickPocScheduler(this.config).catch((err) =>
      logger.error({ err }, "POC scheduler tick error"),
    );

    const running = await countTasksByState("running");
    const capacity = this.maxParallelScan - running;

    if (capacity <= 0) return;

    const queued = await getQueuedTasks(capacity);
    if (queued.length === 0) return;

    logger.info({ queued: queued.length, capacity }, "Scheduling queued tasks");

    for (const task of queued) {
      // Detect resume: if started_at is set, task was previously running/paused
      const isResume = task.started_at != null;

      // Get LLM credentials — task-specific or default
      const credId = (task as DbTask & { credential_id?: string }).credential_id;
      let cred;
      try {
        cred = credId
          ? await getCredentialById(credId)
          : await getDefaultCredential();
      } catch (err) {
        if (err instanceof CredentialKeyUnavailableError) {
          const reason = "凭证加密 key 未配置。请管理员设置 VULNHUNT_MASTER_KEY_FILE 并重启服务，或挂载正确的 master key 文件。";
          logger.error({ err, taskId: task.id, credId }, reason);
          await updateTaskState(task.id, "failed", {
            completedAt: new Date(),
            failureReason: reason,
          });
          notify({ type: "task_state", taskId: task.id, state: "failed" as import("@vulnhunt/shared").TaskState });
          continue;
        }
        if (err instanceof CredentialDecryptError) {
          const reason = "LLM credential cannot be decrypted with current master key. Re-save the credential in Settings or restore the original master key.";
          logger.error({ err, taskId: task.id, credId }, reason);
          await updateTaskState(task.id, "failed", {
            completedAt: new Date(),
            failureReason: reason,
          });
          notify({ type: "task_state", taskId: task.id, state: "failed" as import("@vulnhunt/shared").TaskState });
          continue;
        }
        throw err;
      }
      if (!cred) {
        logger.warn({ taskId: task.id }, "No LLM credentials available — skipping");
        continue;
      }

      const llmEnv = credentialToWorkerEnv(cred);

      try {
        if (!isResume) {
          await this.prepareWorkspace(task);
        }
        await spawnScanWorker(task, this.config, llmEnv, isResume);

        // Start tailing service event files
        const hostWorkDir = getHostWorkDir(this.config.dataDir, task.id);
        const eventsDir = join(hostWorkDir, "out", ".youngflow", "logs");
        startTailing(task.id, [], [{ path: eventsDir, source: "scan" }]);

        if (isResume) {
          logger.info({ taskId: task.id }, "Task resumed from paused state");
        }
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
    // Defensive: source_meta may be double-serialized JSONB string
    let meta = task.source_meta as { minio_key?: string } | string;
    if (typeof meta === "string") {
      try { meta = JSON.parse(meta); } catch { meta = {}; }
    }
    const minioKey = (meta as { minio_key?: string })?.minio_key ?? `code-packages/${task.id}.zip`;

    const zipPath = join(hostWorkDir, "source.zip");
    const minio = getMinio();

    // Wait for code package (git clone runs async after task creation)
    const maxWaitSec = 120;
    for (let attempt = 0; attempt < maxWaitSec; attempt++) {
      try {
        await minio.statObject(this.config.minio.bucket, minioKey);
        break; // zip exists
      } catch {
        if (attempt === maxWaitSec - 1) {
          throw new Error(`Code package not ready after ${maxWaitSec}s: ${minioKey}`);
        }
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    await minio.fGetObject(this.config.minio.bucket, minioKey, zipPath);
    execSync(`cd "${srcDir}" && unzip -o -q "${zipPath}"`, { timeout: 60_000, stdio: "pipe" });
    logger.info({ taskId: task.id, minioKey }, "Code package extracted to workspace");
  }

  private async extractMetadata(taskId: string): Promise<void> {
    const db = getDb();
    const hostWorkDir = getHostWorkDir(this.config.dataDir, taskId);
    const metadata: Record<string, unknown> = {};

    // 1. Profiler data
    try {
      const profilerPath = join(hostWorkDir, "out", "profiler", "project-profiler.yaml");
      const raw = readFileSync(profilerPath, "utf-8");
      const profiler = yamlLoad(raw) as Record<string, unknown>;
      const techStack = (profiler.tech_stack ?? profiler) as Record<string, unknown>;
      const codeStats = (profiler.code_stats ?? profiler) as Record<string, unknown>;
      const basicInfo = (profiler.basic_info ?? profiler) as Record<string, unknown>;
      metadata.profile = {
        project_name: basicInfo.project_name,
        language: techStack.language ?? profiler.primary_language,
        build_system: techStack.package_manager ?? profiler.build_system,
        total_files: codeStats.file_count ?? profiler.total_files,
        total_loc: codeStats.loc ?? profiler.total_loc,
        description: (profiler.scan_scope as Record<string, unknown>)?.description ?? profiler.description,
      };
    } catch {
      // Profiler output may not exist
    }

    // 2. Execution stats from service events
    try {
      const eventsDir = join(hostWorkDir, "out", ".youngflow", "logs");
      const eventsFile = join(eventsDir, "youngflow.service.jsonl");
      const lines = readFileSync(eventsFile, "utf-8").split("\n").filter(Boolean);
      let totalTokensIn = 0;
      let totalTokensOut = 0;
      let toolCallCount = 0;
      let stageCount = 0;
      let flowStagesTotal = 0;
      let flowStagesCompleted = 0;
      let flowStagesFailed = 0;

      for (const line of lines) {
        try {
          const ev = JSON.parse(line);
          if (ev.event === "stage_done" || ev.type === "stage_end") {
            stageCount++;
            totalTokensIn += ev.tokens_in ?? 0;
            totalTokensOut += ev.tokens_out ?? 0;
            toolCallCount += ev.tools ?? 0;
          }
          if (ev.event === "flow_end") {
            flowStagesTotal = Number(ev.stages_total ?? 0);
            flowStagesCompleted = Number(ev.stages_completed ?? 0);
            flowStagesFailed = Number(ev.stages_failed ?? 0);
          }
        } catch { /* skip bad lines */ }
      }

      metadata.execution = {
        model: undefined, // filled from cred below
        stages_completed: flowStagesCompleted || stageCount,
        stages_total: flowStagesTotal || stageCount,
        stages_failed: flowStagesFailed,
        warning: flowStagesFailed > 0 ? `${flowStagesFailed} agent/stage failures` : undefined,
        total_tokens_in: totalTokensIn,
        total_tokens_out: totalTokensOut,
        tool_call_count: toolCallCount,
      };

      // Update numeric columns too
      await db`
        UPDATE tasks SET
          total_tokens_in = ${totalTokensIn},
          total_tokens_out = ${totalTokensOut},
          tool_call_count = ${toolCallCount},
          stage_count = ${stageCount}
        WHERE id = ${taskId}
      `;
    } catch {
      // Events file may not exist
    }

    // 3. Model info from credential
    try {
      const cred = await getDefaultCredential();
      if (cred && metadata.execution) {
        (metadata.execution as Record<string, unknown>).model = `${cred.proto_type}/${cred.model_id}`;
      }
    } catch { /* ok */ }

    // Save metadata
    if (Object.keys(metadata).length > 0) {
      await db`UPDATE tasks SET metadata = ${JSON.stringify(metadata)}::jsonb WHERE id = ${taskId}`;
      logger.info({ taskId, keys: Object.keys(metadata) }, "Task metadata extracted");
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
