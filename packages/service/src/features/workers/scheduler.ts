/**
 * TaskScheduler: polls queued tasks every 5s, spawns workers up to max_parallel.
 * Also handles docker events (start/die/oom) to update task state.
 */

import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { load as yamlLoad } from "js-yaml";

import { logger } from "../../infra/logger.js";
import { getDb } from "../../infra/db/client.js";
import { countTasksByState, getQueuedTasks, getRunningTaskIds, getTaskById, updateTaskState, clearContinueMode, isContinueMode, mergeTaskMetadata, type DbTask } from "../tasks/storage.js";
import { subscribeToDockerEvents, ensureWorkDir } from "./docker-client.js";
import { spawnScanWorker, getHostWorkDir } from "./scan-worker.js";
import { downloadObjectWithRetry } from "./minio-download.js";
import { getDefaultCredential, getCredentialById } from "../settings/storage.js";
import { CredentialDecryptError, CredentialKeyUnavailableError } from "../../infra/crypto/master-key-vault.js";
import { credentialToWorkerEnv } from "../settings/credential-env.js";
import { startTailing, stopTailing } from "../events/event-tail.js";
import { indexFindings } from "../findings/indexer.js";
import { syncOutputsToMinio, downloadOutputsFromMinio } from "./sync-outputs.js";
import { getMinio } from "../../infra/minio/client.js";
import { onChatContainerDie } from "../chat/chat-session.js";
import { appendEvent } from "../events/event-store.js";
import { broadcastEvent } from "../events/ws-live-log.js";
import { onReportContainerDie } from "../reports/report-worker.js";
import { onEvalContainerDie, onPocRunContainerDie, tickPocScheduler } from "../poc/scheduler.js";
import { notify } from "../notifications/index.js";
import type { ServiceConfig } from "../../infra/config.js";
import { resolveArchiveIdentity } from "../source-archives/detect.js";
import { extractSourceArchive } from "../source-archives/extract.js";
import { getSourceArchivePolicy } from "../source-archives/policy.js";
import {
  evaluateAuditCompletion,
  isSameAuditCompletion,
  mapAuditCompletionFinalState,
  mergeExecutionWarnings,
  needsTerminalStateReconciliation,
} from "./audit-completion.js";
import type { LiveLogEvent, TaskAuditCompletion, TaskEngineRun } from "@vulnagent/shared";

export function summarizeExecutionEvents(lines: string[]): {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  toolCallCount: number;
  stageCount: number;
  flowStagesTotal: number;
  flowStagesCompleted: number;
  flowStagesFailed: number;
} {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let totalTokens = 0;
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
        const input = Number(ev.input_tokens ?? ev.tokens_in ?? 0) || 0;
        const output = Number(ev.output_tokens ?? ev.tokens_out ?? 0) || 0;
        const cacheRead = Number(ev.cache_read_tokens ?? ev.tokens_cache_read ?? 0) || 0;
        const cacheWrite = Number(ev.cache_write_tokens ?? ev.tokens_cache_write ?? 0) || 0;
        const stageTotal = Number(ev.total_tokens ?? ev.tokens_total ?? 0) || 0;
        const computedStageTotal = input + output + cacheRead + cacheWrite;

        inputTokens += input;
        outputTokens += output;
        cacheReadTokens += cacheRead;
        cacheWriteTokens += cacheWrite;
        totalTokens += stageTotal > 0 ? Math.max(stageTotal, computedStageTotal) : computedStageTotal;
        toolCallCount += Number(ev.tools ?? 0) || 0;
      }
      if (ev.event === "flow_end") {
        flowStagesTotal = Number(ev.stages_total ?? 0);
        flowStagesCompleted = Number(ev.stages_completed ?? 0);
        flowStagesFailed = Number(ev.stages_failed ?? 0);
      }
    } catch { /* skip bad lines */ }
  }

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    toolCallCount,
    stageCount,
    flowStagesTotal,
    flowStagesCompleted,
    flowStagesFailed,
  };
}

export function missingCredentialFailureReason(credId?: string | null): string {
  return credId
    ? "指定的模型凭证不存在或已不可用，请重新选择模型凭证后重试。"
    : "任务缺少可用模型凭证。请在任务或 Settings 中配置模型凭证后重新创建/重启任务。";
}

/** Incremental findings indexing for running tasks. */
const INCREMENTAL_INDEX_INTERVAL_MS = 90_000;
/** Only sync lightweight business artifacts mid-scan (skip GB-scale session logs). */
const INCREMENTAL_SYNC_DIRS = ["findings", "risks", "knowledge"];

export function appendAndBroadcastCompletionEvent(taskId: string, event: LiveLogEvent): void {
  const entry = appendEvent(taskId, event);
  broadcastEvent(taskId, entry.seq, entry.event);
}
const PROFILER_ARTIFACT_PATHS = [
  "profiler.yaml",
  "knowledge/profiler.yaml",
  "profiler/project-profiler.yaml",
];

export class TaskScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribeEvents: (() => void) | null = null;
  private maxParallelScan = 3;
  private youngflowMaxParallel = 3;
  private config: ServiceConfig;
  /** Last incremental sync+index time per running task (ms). */
  private lastIncrementalAt = new Map<string, number>();

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

      if (event.taskType === "diagnostic") {
        logger.debug({ action, taskId, exitCode }, "Ignoring diagnostic container lifecycle event");
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
          const workerExitCode = exitCode ?? -1;
          const ok = workerExitCode === 0;
          const hostWorkDir = getHostWorkDir(this.config.dataDir, taskId);
          const engineRun = currentTask?.metadata?.engine_run as TaskEngineRun | undefined;
          const completion = evaluateAuditCompletion({
            outDir: join(hostWorkDir, "out"),
            engineRun,
          });
          const previousCompletion = currentTask?.metadata?.audit_completion;
          const shouldEmitTerminal = !isSameAuditCompletion(previousCompletion, completion);

          // Clear continue_mode flag (whether success or failure) so a later
          // restart isn't misread as a continue run.
          try {
            await clearContinueMode(taskId);
          } catch (err) {
            logger.warn({ err, taskId }, "Failed to clear continue_mode flag");
          }
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

          const mapped = mapAuditCompletionFinalState(workerExitCode, completion);
          await this.persistAuditCompletion(taskId, completion).catch((err) =>
            logger.error({ err, taskId }, "Failed to persist audit completion metadata"),
          );

          const reconcileState = needsTerminalStateReconciliation(
            currentTask?.state,
            currentTask?.completed_at,
            mapped.state,
          );
          if (reconcileState) {
            const durationMs = await this.computeDuration(taskId);
            await updateTaskState(taskId, mapped.state, {
              completedAt: new Date(),
              durationMs,
              failureReason: mapped.failureReason,
            }).catch((err) => logger.error({ err, taskId }, "Failed to update task on die"));
            notify({ type: "task_state", taskId, state: mapped.state });
          }

          if (shouldEmitTerminal) {
            if (workerExitCode === 0 && completion.error_code) {
              appendAndBroadcastCompletionEvent(taskId, {
                type: "error",
                source: "service",
                seq: 0,
                ts: new Date().toISOString(),
                code: completion.error_code,
                summary: completion.reason ?? "Audit completion gate failed",
              });
            }
            appendAndBroadcastCompletionEvent(taskId, {
              type: "task_status",
              source: "service",
              seq: 0,
              ts: new Date().toISOString(),
              status: mapped.state === "completed" ? "completed" : "failed",
              severity: mapped.severity,
              reason: mapped.eventReason,
            });
          }
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
      const rows = await db<{ config: { max_parallel_scan: number; youngflow_max_parallel?: number } }[]>`
        SELECT config FROM system_config WHERE id = 1
      `;
      if (rows[0]) {
        this.maxParallelScan = Number(rows[0].config.max_parallel_scan) || 3;
        this.youngflowMaxParallel = Number(rows[0].config.youngflow_max_parallel) || 3;
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

    // Incremental findings indexing for running tasks (before the capacity
    // early-return, since running>=max means capacity<=0 yet we still want
    // running tasks' findings to surface mid-scan).
    await this.tickIncrementalIndex().catch((err) =>
      logger.error({ err }, "Incremental index tick error"),
    );

    const running = await countTasksByState("running");
    const capacity = this.maxParallelScan - running;

    if (capacity <= 0) return;

    // Fetch beyond immediate capacity so invalid queued items (e.g. old tasks
    // without credentials) can be failed in this tick instead of starving valid
    // newer tasks that sit behind them.
    const queued = await getQueuedTasks(Math.max(capacity, 20));
    if (queued.length === 0) return;

    logger.info({ queued: queued.length, capacity }, "Scheduling queued tasks");

    let spawned = 0;
    for (const task of queued) {
      if (spawned >= capacity) break;
      // Detect continue mode (re-run on top of existing outputs) vs resume
      // (paused container respawn). Continue clears started_at, so it would
      // otherwise look like a fresh run.
      const isContinue = isContinueMode(task);
      // Detect resume: if started_at is set, task was previously running/paused
      const isResume = task.started_at != null && !isContinue;

      // Get LLM credentials — task-specific or default
      const credId = (task as DbTask & { credential_id?: string }).credential_id;
      let cred;
      try {
        cred = credId
          ? await getCredentialById(credId)
          : await getDefaultCredential();
      } catch (err) {
        if (err instanceof CredentialKeyUnavailableError) {
          const reason = "凭证加密 key 未配置。请管理员设置 VULNAGENT_MASTER_KEY_FILE 并重启服务，或挂载正确的 master key 文件。";
          logger.error({ err, taskId: task.id, credId }, reason);
          await updateTaskState(task.id, "failed", {
            completedAt: new Date(),
            failureReason: reason,
          });
          notify({ type: "task_state", taskId: task.id, state: "failed" as import("@vulnagent/shared").TaskState });
          continue;
        }
        if (err instanceof CredentialDecryptError) {
          const reason = "LLM credential cannot be decrypted with current master key. Re-save the credential in Settings or restore the original master key.";
          logger.error({ err, taskId: task.id, credId }, reason);
          await updateTaskState(task.id, "failed", {
            completedAt: new Date(),
            failureReason: reason,
          });
          notify({ type: "task_state", taskId: task.id, state: "failed" as import("@vulnagent/shared").TaskState });
          continue;
        }
        throw err;
      }
      if (!cred) {
        const reason = missingCredentialFailureReason(credId);
        logger.warn({ taskId: task.id, credId }, reason);
        await updateTaskState(task.id, "failed", {
          completedAt: new Date(),
          failureReason: reason,
        });
        notify({ type: "task_state", taskId: task.id, state: "failed" as import("@vulnagent/shared").TaskState });
        continue;
      }

      const llmEnv = { ...credentialToWorkerEnv(cred), YOUNGFLOW_MAX_PARALLEL: String(this.youngflowMaxParallel) };

      try {
        if (isContinue) {
          // Continue: re-extract source then pull historical outputs back into
          // the workspace so YoungFlow --continue can build on prior artifacts.
          await this.prepareWorkspace(task);
          const downloaded = await downloadOutputsFromMinio(task.id, this.config);
          logger.info({ taskId: task.id, downloaded }, "Historical outputs restored for continue");
        } else if (!isResume) {
          await this.prepareWorkspace(task);
        }
        await spawnScanWorker(task, this.config, llmEnv, isResume, isContinue);

        // Start tailing service event files
        const hostWorkDir = getHostWorkDir(this.config.dataDir, task.id);
        const eventsDir = join(hostWorkDir, "out", ".youngflow", "logs");
        const serviceLogsDir = join(hostWorkDir, ".service-logs");
        startTailing(task.id, [], [{ path: eventsDir, source: "scan" }, { path: serviceLogsDir, source: "scan" }]);

        spawned++;

        if (isContinue) {
          logger.info({ taskId: task.id }, "Task continued on top of existing outputs");
        } else if (isResume) {
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

  /**
   * Periodically sync + index findings for running tasks so the UI surfaces
   * vulnerabilities mid-scan instead of only at task completion. Throttled per
   * task (every INCREMENTAL_INDEX_INTERVAL_MS), and syncs only the lightweight
   * business-artifact dirs to avoid re-uploading GB-scale session logs each
   * cycle. Failures are warn-only — never affect task state. The terminal
   * sync+index after container exit remains the source of final consistency.
   */
  private async tickIncrementalIndex(): Promise<void> {
    const runningIds = await getRunningTaskIds();
    const runningSet = new Set(runningIds);
    // Drop bookkeeping for tasks no longer running.
    for (const id of this.lastIncrementalAt.keys()) {
      if (!runningSet.has(id)) this.lastIncrementalAt.delete(id);
    }

    const now = Date.now();
    for (const taskId of runningIds) {
      const last = this.lastIncrementalAt.get(taskId) ?? 0;
      if (now - last < INCREMENTAL_INDEX_INTERVAL_MS) continue;
      this.lastIncrementalAt.set(taskId, now);
      try {
        await syncOutputsToMinio(taskId, this.config, { includeDirs: INCREMENTAL_SYNC_DIRS });
        const count = await indexFindings(taskId, this.config.minio.bucket);
        notify({ type: "findings_indexed", taskId, count });
      } catch (err) {
        logger.warn({ err, taskId }, "Incremental findings index failed (non-fatal)");
      }
    }
  }

  private async prepareWorkspace(task: DbTask): Promise<void> {
    const hostWorkDir = getHostWorkDir(this.config.dataDir, task.id);
    const srcDir = join(hostWorkDir, "src");
    ensureWorkDir(srcDir);

    // Download code package from MinIO and extract.
    const archive = resolveArchiveIdentity({ taskId: task.id, sourceMeta: task.source_meta });
    const minioKey = archive.minioKey;
    const archivePath = join(hostWorkDir, "source-archive");
    const minio = getMinio();

    // Wait for code package (git clone runs async after task creation; large repos
    // can take up to 10min clone + retries + zip + upload). Align with git-clone budget.
    const maxWaitSec = 720;
    for (let attempt = 0; attempt < maxWaitSec; attempt++) {
      try {
        await minio.statObject(this.config.minio.bucket, minioKey);
        break; // archive exists
      } catch {
        if (attempt === maxWaitSec - 1) {
          throw new Error(`Code package not ready after ${maxWaitSec}s: ${minioKey}`);
        }
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    // Download with retry: fGetObject right after upload can hit a transient
    // read-after-write size mismatch (prod task bab9d1d3). The object is
    // complete server-side (git-clone verifies size on upload); a single
    // zero-retry call turned the blip into a permanent task failure.
    await downloadObjectWithRetry(minio, this.config.minio.bucket, minioKey, archivePath);
    await extractSourceArchive(archivePath, archive.filename, srcDir, await getSourceArchivePolicy());
    logger.info({ taskId: task.id, minioKey, filename: archive.filename }, "Code package extracted to workspace");
  }

  private async persistAuditCompletion(taskId: string, completion: TaskAuditCompletion): Promise<void> {
    const task = await getTaskById(taskId);
    const execution = task?.metadata?.execution;
    const existingWarning = execution && typeof execution === "object"
      ? (execution as Record<string, unknown>).warning
      : undefined;
    const warning = mergeExecutionWarnings(existingWarning, completion);
    const patch: import("@vulnagent/shared").TaskMetadata = {
      audit_completion: completion,
      execution: { warning: warning ?? null },
    };
    await mergeTaskMetadata(taskId, patch);
  }

  private async extractMetadata(taskId: string): Promise<void> {
    const db = getDb();
    const hostWorkDir = getHostWorkDir(this.config.dataDir, taskId);
    const metadata: Record<string, unknown> = {};

    // 1. Profiler data
    try {
      const profilerPath = PROFILER_ARTIFACT_PATHS
        .map((p) => join(hostWorkDir, "out", ...p.split("/")))
        .find((p) => existsSync(p));
      if (!profilerPath) throw new Error("profiler artifact not found");
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
      const summary = summarizeExecutionEvents(lines);

      metadata.execution = {
        model: undefined, // filled from cred below
        stages_completed: summary.flowStagesCompleted || summary.stageCount,
        stages_total: summary.flowStagesTotal || summary.stageCount,
        stages_failed: summary.flowStagesFailed,
        warning: summary.flowStagesFailed > 0 ? `${summary.flowStagesFailed} agent/stage failures` : null,
        input_tokens: summary.inputTokens,
        output_tokens: summary.outputTokens,
        cache_read_tokens: summary.cacheReadTokens,
        cache_write_tokens: summary.cacheWriteTokens,
        total_tokens: summary.totalTokens,
        total_tokens_in: summary.inputTokens,
        total_tokens_out: summary.outputTokens,
        tool_call_count: summary.toolCallCount,
      };

      // Update numeric columns too
      await db`
        UPDATE tasks SET
          total_tokens_in = ${summary.inputTokens},
          total_tokens_out = ${summary.outputTokens},
          input_tokens = ${summary.inputTokens},
          output_tokens = ${summary.outputTokens},
          cache_read_tokens = ${summary.cacheReadTokens},
          cache_write_tokens = ${summary.cacheWriteTokens},
          total_tokens = ${summary.totalTokens},
          tool_call_count = ${summary.toolCallCount},
          stage_count = ${summary.stageCount}
        WHERE id = ${taskId}
      `;
    } catch {
      // Events file may not exist
    }

    // 3. Model info from task-specific credential (fallback to default)
    try {
      const task = await getTaskById(taskId);
      const cred = task?.credential_id
        ? await getCredentialById(task.credential_id)
        : await getDefaultCredential();
      if (cred && metadata.execution) {
        (metadata.execution as Record<string, unknown>).model = `${cred.proto_type}/${cred.model_id}`;
      }
    } catch { /* ok */ }

    // Merge metadata: engine_run/audit_completion and future top-level keys
    // are durable run provenance and must not be erased by profiler extraction.
    if (Object.keys(metadata).length > 0) {
      await mergeTaskMetadata(taskId, metadata);
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
