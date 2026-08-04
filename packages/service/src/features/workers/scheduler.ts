/**
 * TaskScheduler: polls queued tasks every 5s, spawns workers up to max_parallel.
 * Also handles docker events (start/die/oom) to update task state.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { load as yamlLoad } from "js-yaml";

import { logger } from "../../infra/logger.js";
import { getDb } from "../../infra/db/client.js";
import {
  claimQueuedScanTasks,
  failSchedulerClaim,
  getRunningTaskIds,
  getTaskById,
  markSchedulerClaimRunning,
  renewSchedulerClaim,
  clearContinueMode,
  getSchedulerClaim,
  listStuckDeadlineRunningTasks,
  mergeTaskMetadata,
  requeueSchedulerClaim,
  updateTaskState,
  SCHEDULER_CLAIM_HEARTBEAT_MS,
  type ClaimedScanTask,
  type DbTask,
} from "../tasks/storage.js";
import { SCAN_FALLBACK_MARGIN_S } from "../tasks/scan-duration.js";
import { subscribeToDockerEvents, ensureWorkDir } from "./docker-client.js";
import { spawnScanWorker, getHostWorkDir, hasRunningScanWorkerByClaim, stopScanWorker, stopScanWorkerByClaim } from "./scan-worker.js";
import { cleanupSchedulerWorkspace, getSchedulerPrepareDir, publishSchedulerWorkspace } from "./scheduler-workspace.js";
import { isDynamicEnabled, runPrepareWorker, stopPrepareWorkerByClaim, type PrepareResult } from "./prepare-worker.js";
import {
  ensureSandboxForTask,
  stopSandboxForTask,
  reconcileSandboxes,
  SandboxQuotaError,
} from "../sandboxes/lifecycle.js";
import { scanOutputsForKeyMaterial } from "./sandbox-inject.js";
import { SandboxPlaneCapacityError } from "../sandbox-plane/client.js";
import { reconcileSchedulerClaims } from "./reconciler.js";
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
import type { LiveLogEvent, TaskAuditCompletion, TaskEngineRun } from "@vulnhunter/shared";

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
  let observedStageEvents = 0;
  let fallbackFlowStagesTotal = 0;
  let fallbackFlowStagesCompleted = 0;
  let fallbackFlowStagesFailed = 0;

  for (const line of lines) {
    try {
      const ev = JSON.parse(line);
      if (ev.event === "stage_done" || ev.type === "stage_end") {
        stageCount++;
        observedStageEvents++;
        flowStagesTotal++;
        const failed = (Number(ev.exit_code ?? 0) || 0) !== 0 || ev.status === "failed";
        if (failed) flowStagesFailed++;
        else flowStagesCompleted++;
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
        // A timeout-finalized scan contains two flow_end events. Preserve the
        // event only as a legacy fallback; observed stage_done events are the
        // authoritative cumulative count across both runs.
        fallbackFlowStagesTotal = Number(ev.stages_total ?? 0) || 0;
        fallbackFlowStagesCompleted = Number(ev.stages_completed ?? 0) || 0;
        fallbackFlowStagesFailed = Number(ev.stages_failed ?? 0) || 0;
      }
    } catch { /* skip bad lines */ }
  }

  if (observedStageEvents === 0) {
    flowStagesTotal = fallbackFlowStagesTotal;
    flowStagesCompleted = fallbackFlowStagesCompleted;
    flowStagesFailed = fallbackFlowStagesFailed;
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
/** H2 §3: sandbox allocation retry budget (6 × 5min) before the O1-visible error. */
// Permanent queue until capacity/quota frees or user cancels (contract B2).
// Retained for log context only — no longer a terminal cutoff.
const SANDBOX_ALLOC_RETRY_MS = 5 * 60_000;
/** H2 §5: incremental sandbox reconcile cadence (startup does the full pass). */
const SANDBOX_RECONCILE_INTERVAL_MS = 60_000;

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
  private config: ServiceConfig;
  private readonly ownerInstanceId = randomUUID();
  private readonly claimHeartbeats = new Set<ReturnType<typeof setInterval>>();
  /** Last incremental sync+index time per running task (ms). */
  private lastIncrementalAt = new Map<string, number>();
  private lastSandboxReconcileAt = 0;

  constructor(config: ServiceConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    await this.refreshConfig();

    // Subscribe to docker events
    this.unsubscribeEvents = subscribeToDockerEvents(async (event) => {
      const { action, taskId, claimToken, exitCode } = event;

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
        if (currentTask?.state === "preparing") {
          const claim = getSchedulerClaim(currentTask);
          if (claim && claimToken === claim.token) {
            const failed = await failSchedulerClaim(taskId, claim.token, `Worker exited during preparation with code ${exitCode}`);
            if (failed) {
              await stopScanWorkerByClaim(taskId, claim.token);
              await stopSandboxForTask(taskId, "preparing_failed").catch(() => undefined);
              await cleanupSchedulerWorkspace(getHostWorkDir(this.config.dataDir, taskId), claim.token).catch(() => undefined);
              notify({ type: "task_state", taskId, state: "failed" });
            }
          } else {
            logger.warn({ taskId, claimToken, currentToken: claim?.token }, "Ignoring stale-token scan die event during preparation");
          }
          return;
        }
        if (currentTask && ["cancelled", "paused"].includes(currentTask.state)) {
          logger.info({ taskId, dbState: currentTask.state, exitCode }, "Container died but task already cancelled/paused, skipping state update");
          // Still sync outputs for cancelled tasks (may have partial results)
          if (currentTask.state === "cancelled") {
            try {
              if (await this.guardNoKeyMaterialLeak(taskId)) {
                await syncOutputsToMinio(taskId, this.config);
              }
            } catch (err) {
              logger.warn({ err, taskId }, "Failed to sync outputs on cancel");
            }
            await stopSandboxForTask(taskId, "task_cancelled").catch(() => undefined);
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
              if (await this.guardNoKeyMaterialLeak(taskId)) {
                await syncOutputsToMinio(taskId, this.config);
              }
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
            // H2 §4: terminal (completed/failed) — stop the sandbox, keep it.
            await stopSandboxForTask(taskId, `task_${mapped.state}`).catch(() => undefined);
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
    for (const heartbeat of this.claimHeartbeats) clearInterval(heartbeat);
    this.claimHeartbeats.clear();
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

    // Incremental findings indexing for running tasks (before the capacity
    // early-return, since running>=max means capacity<=0 yet we still want
    // running tasks' findings to surface mid-scan).
    await this.tickIncrementalIndex().catch((err) =>
      logger.error({ err }, "Incremental index tick error"),
    );

    // H3 §3 (form A): platform fallback for a running task whose accounted
    // scan deadline is stuck (past deadline_at + 720s with no terminal state).
    // The worker normally self-finalizes at its own deadline; this only fires
    // when the worker became unresponsive / its clock was reset before its
    // bounded finalizer finished. Force-stop the container and let the
    // claim-aware die/terminal-reconcile path finalize the task as failed.
    await this.tickStuckDeadlineFallback().catch((err) =>
      logger.error({ err }, "Stuck-deadline fallback tick error"),
    );

    await reconcileSchedulerClaims(this.config).catch((err) =>
      logger.error({ err }, "Scheduler claim reconciliation failed"),
    );

    // H2 §5: incremental sandbox reconcile (full pass runs at service boot).
    if (Date.now() - this.lastSandboxReconcileAt >= SANDBOX_RECONCILE_INTERVAL_MS) {
      this.lastSandboxReconcileAt = Date.now();
      await reconcileSandboxes().catch((err) =>
        logger.error({ err }, "Sandbox reconcile tick error"),
      );
    }

    const claimed = await claimQueuedScanTasks(this.maxParallelScan, this.ownerInstanceId);
    if (claimed.length === 0) return;
    logger.info({ claimed: claimed.length, ownerInstanceId: this.ownerInstanceId }, "Scheduling claimed tasks");
    await Promise.allSettled(claimed.map((task) => this.processClaimedTask(task)));
  }

  private async assertSchedulerOwnership(taskId: string, token: string): Promise<void> {
    if (!await renewSchedulerClaim(taskId, token)) {
      throw Object.assign(new Error("Scheduler claim lost or deadline exceeded"), { code: "ERR_SCHEDULER_CLAIM_LOST" });
    }
  }

  /**
   * Force-stop running tasks whose platform-accounted scan deadline is stuck
   * (H3 §3). Only acts when `now > deadline_at + 720s` — never inside the
   * worker's own bounded-finalizer window, so it cannot kill a report being
   * written. The container stop triggers the normal docker die event, whose
   * claim-aware handler runs the terminal reconcile (task → failed, partial
   * outputs preserved via output-sync). The platform does not inject a
   * finalizer itself (the worker is unresponsive; re-running the finalize flow
   * is out of H3 scope).
   */
  private async tickStuckDeadlineFallback(): Promise<void> {
    const stuck = await listStuckDeadlineRunningTasks(SCAN_FALLBACK_MARGIN_S);
    for (const task of stuck) {
      logger.warn(
        { taskId: task.id, deadlineAt: (task.metadata as Record<string, unknown> | undefined)?.deadline_at },
        "Scan task exceeded deadline + fallback margin without terminal state; forcing stop (worker judged unresponsive)",
      );
      await stopScanWorker(task.id).catch((err) =>
        logger.warn({ err, taskId: task.id }, "Failed to force-stop stuck-deadline scan worker"),
      );
    }
  }

  private async processClaimedTask(task: ClaimedScanTask): Promise<void> {
    const claim = task.scheduler_claim;
    const token = claim.token;
    const hostWorkDir = getHostWorkDir(this.config.dataDir, task.id);
    let published = false;
    let workerStarted = false;
    const heartbeat = setInterval(() => {
      renewSchedulerClaim(task.id, token).then((renewed) => {
        if (!renewed) logger.warn({ taskId: task.id, token }, "Scheduler claim heartbeat lost");
      }).catch((err) => logger.warn({ err, taskId: task.id, token }, "Scheduler claim heartbeat failed"));
    }, SCHEDULER_CLAIM_HEARTBEAT_MS);
    heartbeat.unref?.();
    this.claimHeartbeats.add(heartbeat);

    try {
      await this.assertSchedulerOwnership(task.id, token);
      const credId = task.credential_id;
      let cred;
      try {
        cred = credId ? await getCredentialById(credId) : await getDefaultCredential();
      } catch (err) {
        if (err instanceof CredentialKeyUnavailableError) {
          throw new Error("凭证加密 key 未配置。请管理员设置 VULNHUNTER_MASTER_KEY_FILE并重启服务，或挂载正确的 master key 文件。");
        }
        if (err instanceof CredentialDecryptError) {
          throw new Error("LLM credential cannot be decrypted with current master key. Re-save the credential in Settings or restore the original master key.");
        }
        throw err;
      }
      if (!cred) throw new Error(missingCredentialFailureReason(credId));
      await this.assertSchedulerOwnership(task.id, token);
      // Scan worker gets the real LLM credential directly (fish 2026-08-04:
      // model-proxy removed — workers carry user-owned keys).
      const llmEnv = {
        ...credentialToWorkerEnv(cred),
        YOUNGFLOW_MAX_PARALLEL: String(task.agent_max_parallel ?? 3),
      };

      if (claim.mode === "continue") {
        published = await this.prepareWorkspace(task, token);
        await this.assertSchedulerOwnership(task.id, token);
        const downloaded = await downloadOutputsFromMinio(task.id, this.config);
        logger.info({ taskId: task.id, downloaded, token }, "Historical outputs restored for continue");
      } else if (claim.mode === "fresh") {
        published = await this.prepareWorkspace(task, token);
      }

      // H5: run the Prepare phase (source completeness + dynamic sandbox
      // selection) for any mode that (re)prepared source. Resume reuses the
      // paused container's existing source and does not re-prepare.
      let prepareResult: PrepareResult | null = null;
      if (claim.mode === "fresh" || claim.mode === "continue") {
        prepareResult = await this.runPreparePhase(task, token, hostWorkDir);
        await this.assertSchedulerOwnership(task.id, token);
      }

      // H2 §3: dynamic on + a sandbox selection (fresh prepare result OR the
      // persisted one on resume) → allocate before the scan worker starts.
      // ensureSandboxForTask is idempotent: ready→reuse, stopped→resume,
      // key-lost (restart)→recycle. Quota/capacity rejections requeue the
      // task with bounded backoff (see allocateSandboxForTask).
      const persistedSelection = ((task.metadata as Record<string, unknown> | undefined)?.prepare as { sandbox_type?: string | null } | undefined)?.sandbox_type;
      const resolvedSelection = prepareResult?.sandbox_type ?? persistedSelection;
      if (isDynamicEnabled(task) && resolvedSelection) {
        // Pass the freshly resolved selection down — the in-memory task can
        // predate prepare persistence and must not be re-read for it (P0-2).
        await this.allocateSandboxForTask(task, token, resolvedSelection);
        await this.assertSchedulerOwnership(task.id, token);
      }

      await this.assertSchedulerOwnership(task.id, token);
      await spawnScanWorker(task, this.config, llmEnv, token, claim.mode === "resume", claim.mode === "continue");
      workerStarted = true;
      const marked = await markSchedulerClaimRunning(task.id, token, new Date());
      if (!marked) {
        const current = await getTaskById(task.id);
        const adopted = current?.state === "running" && await hasRunningScanWorkerByClaim(task.id, token);
        if (!adopted) {
          await stopScanWorkerByClaim(task.id, token);
          throw Object.assign(new Error("Scheduler claim lost after Worker start"), { code: "ERR_SCHEDULER_CLAIM_LOST" });
        }
        logger.info({ taskId: task.id, token }, "Worker was adopted by reconciler before owner commit");
      } else {
        notify({ type: "task_state", taskId: task.id, state: "running" });
      }

      const eventsDir = join(hostWorkDir, "out", ".youngflow", "logs");
      const serviceLogsDir = join(hostWorkDir, ".service-logs");
      try {
        startTailing(task.id, [], [{ path: eventsDir, source: "scan" }, { path: serviceLogsDir, source: "scan" }]);
      } catch (err) {
        logger.warn({ err, taskId: task.id, token }, "Worker is running but event tailing could not start");
      }
      logger.info({ taskId: task.id, token, mode: claim.mode }, "Claimed scan task is running");
    } catch (err) {
      // H2 §3: transient sandbox quota/capacity blocker — requeue with backoff
      // instead of failing the claim. The task stays queued for a later tick.
      if ((err as { code?: string } | null)?.code === "ERR_SANDBOX_ALLOC_REQUEUE") {
        const requeued = await requeueSchedulerClaim(task.id, token).catch(() => false);
        if (requeued) {
          await stopPrepareWorkerByClaim(task.id, token).catch(() => undefined);
          await cleanupSchedulerWorkspace(hostWorkDir, token).catch(() => undefined);
          logger.info({ taskId: task.id, token }, "Claim requeued for sandbox allocation backoff");
          return;
        }
        logger.warn({ taskId: task.id, token }, "Requeue failed (claim lost?); falling through to normal failure path");
      }
      logger.error({ err, taskId: task.id, token }, "Claimed scan task failed");
      const failed = await failSchedulerClaim(task.id, token, String(err)).catch(() => false);
      if (failed) {
        await stopScanWorkerByClaim(task.id, token);
        await stopPrepareWorkerByClaim(task.id, token).catch((cleanupErr) =>
          logger.warn({ cleanupErr, taskId: task.id, token }, "Failed to stop claim-owned prepare worker on failure"),
        );
        // H2 §4: a sandbox allocated before the failure must not stay running.
        await stopSandboxForTask(task.id, "claim_failed").catch(() => undefined);
        if (published) await rm(join(hostWorkDir, "src"), { recursive: true, force: true }).catch((cleanupErr) =>
          logger.warn({ cleanupErr, taskId: task.id, token }, "Failed to remove owner-published source"),
        );
        notify({ type: "task_state", taskId: task.id, state: "failed" });
      } else {
        const current = await getTaskById(task.id).catch(() => null);
        const adopted = current?.state === "running" && workerStarted && await hasRunningScanWorkerByClaim(task.id, token).catch(() => false);
        if (!adopted && workerStarted) await stopScanWorkerByClaim(task.id, token);
        logger.warn({ taskId: task.id, token, currentState: current?.state }, "Claim lost; skipped task-state and canonical-workspace cleanup");
      }
    } finally {
      clearInterval(heartbeat);
      this.claimHeartbeats.delete(heartbeat);
      await cleanupSchedulerWorkspace(hostWorkDir, token).catch((err) =>
        logger.warn({ err, taskId: task.id, token }, "Failed to clean token-private scheduler workspace"),
      );
    }
  }

  /**
   * Run the Prepare phase for a claimed task (H5 §1/§4/§8). Spawns the
   * one-shot prepare worker against the published source, consumes the
   * three-field result, records it in task metadata, emits the prepare events,
   * and applies the branch matrix:
   *   - partial_source        → interrupt: fail in preparing with a reason
   *                              (dynamic/static alike; no scan, no sandbox);
   *   - complete + dynamic on + no compatible sandbox → O1: fail in preparing;
   *   - otherwise             → proceed to the scan worker.
   * All side effects run under the owner's scheduler claim (②). Throws on any
   * prepare failure so processClaimedTask's catch fails the claim.
   */
  private async runPreparePhase(task: ClaimedScanTask, token: string, hostWorkDir: string): Promise<PrepareResult> {
    const dynamicEnabled = isDynamicEnabled(task);
    appendAndBroadcastCompletionEvent(task.id, {
      type: "prepare_started",
      source: "scan",
      seq: 0,
      ts: new Date().toISOString(),
      dynamic_enabled: dynamicEnabled,
    });

    const result = await runPrepareWorker({ task, config: this.config, hostWorkDir, claimToken: token });

    // Record the three-field result verbatim for the task detail / branch
    // provenance. The dynamic-allocation fields (sandbox_cfg etc.) are filled
    // by the H2 batch; for now we persist the selection only.
    await mergeTaskMetadata(task.id, {
      prepare: {
        project_complete: result.project_complete,
        sandbox_type: result.sandbox_type,
        reason: result.reason,
        dynamic_enabled: dynamicEnabled,
        at: new Date().toISOString(),
      },
    }).catch((err) => logger.warn({ err, taskId: task.id }, "Failed to persist prepare result metadata"));

    appendAndBroadcastCompletionEvent(task.id, {
      type: "prepare_completed",
      source: "scan",
      seq: 0,
      ts: new Date().toISOString(),
      project_complete: result.project_complete,
      sandbox_type: result.sandbox_type,
      reason: result.reason,
    });

    if (!result.project_complete) {
      // partial_source: INTERRUPT (fish 2026-07-20). The audit target must be a
      // self-contained, complete functional project (web app / CLI / library);
      // code fragments, docs, and case demos cannot establish complete code
      // semantics, so the task fails in the prepare phase and reports why —
      // dynamic and static alike (no downgrade, no scan worker, no sandbox).
      await mergeTaskMetadata(task.id, { source_incomplete: true }).catch((err) =>
        logger.warn({ err, taskId: task.id }, "Failed to set source_incomplete flag"),
      );
      const remediation = "请补充完整项目源码后重新创建任务";
      appendAndBroadcastCompletionEvent(task.id, {
        type: "prepare_failed",
        source: "scan",
        seq: 0,
        ts: new Date().toISOString(),
        reason: "source_incomplete",
        remediation,
      });
      logger.warn({ taskId: task.id, token }, "Source is incomplete (partial_source); interrupting task");
      throw new Error(
        `源码不完整：功能代码缺失，无法建立完整的代码功能语义。审计目标应是自洽完整的功能项目（如 web 应用、CLI 应用、库）。${remediation}。`,
      );
    }

    if (dynamicEnabled && result.sandbox_type === null) {
      // O1 (fish-approved): complete project, dynamic on, but no compatible
      // sandbox type → fail in preparing with reason + remediation.
      const remediation = "关闭动态验证后重试，或联系管理员启用对应的沙箱类型";
      appendAndBroadcastCompletionEvent(task.id, {
        type: "prepare_failed",
        source: "scan",
        seq: 0,
        ts: new Date().toISOString(),
        reason: "no_compatible_sandbox",
        remediation,
      });
      throw new Error(`未找到兼容的沙箱类型（项目的主要运行方式没有可用的沙箱）。处理办法：${remediation}。`);
    }
    return result;
  }

  /**
   * H2 §3 allocation gate (dynamic on + Prepare selected a sandbox_type):
   * quota check → idempotent create → poll running → mapping. Quota/capacity
   * rejections are transient: the task goes back to queued with a bounded
   * 6×5min retry (claim-skip gate in claimQueuedScanTasks), then the O1-style
   * user-visible error. Anything else propagates as a normal claim failure.
   */
  private async allocateSandboxForTask(task: ClaimedScanTask, token: string, sandboxType: string): Promise<void> {
    const meta = (task.metadata ?? {}) as Record<string, unknown>;
    const alloc = (meta.sandbox_alloc ?? {}) as { attempts?: number; next_attempt_at?: string };
    try {
      const { mapping, reused } = await ensureSandboxForTask(task, { profileId: sandboxType });
      await mergeTaskMetadata(task.id, {
        sandbox_alloc: { attempts: 0, next_attempt_at: null, sandbox_id: mapping.sandbox_id, profile_id: mapping.profile_id },
      }).catch((err) => logger.warn({ err, taskId: task.id }, "Failed to record sandbox_alloc metadata"));
      logger.info({ taskId: task.id, token, sandboxId: mapping.sandbox_id, reused }, "Sandbox ready for dynamic execution");
    } catch (error) {
      if (error instanceof SandboxQuotaError || error instanceof SandboxPlaneCapacityError) {
        const attempts = (alloc.attempts ?? 0) + 1;
        const kind = error instanceof SandboxQuotaError ? "quota" : "capacity";
        // B2: permanent FIFO queue — never terminal-fail on quota/capacity.
        const nextAttemptAt = new Date(Date.now() + SANDBOX_ALLOC_RETRY_MS).toISOString();
        await mergeTaskMetadata(task.id, {
          sandbox_alloc: { attempts, next_attempt_at: nextAttemptAt, last_error: kind },
        }).catch((err) => logger.warn({ err, taskId: task.id }, "Failed to record sandbox_alloc retry"));
        logger.info({ taskId: task.id, token, kind, attempts, nextAttemptAt }, "Sandbox allocation blocked; permanent queue with backoff");
        throw Object.assign(new Error("sandbox allocation backoff"), { code: "ERR_SANDBOX_ALLOC_REQUEUE" });
      }
      throw error;
    }
  }

  /**
   * H1 §7 key-material leak guard. Returns true when the output tree is
   * clean. On a hit: quarantine (metadata + visible event), skip the sync —
   * the private key must never reach MinIO. Expected to never fire.
   */
  private async guardNoKeyMaterialLeak(taskId: string): Promise<boolean> {
    const outDir = join(getHostWorkDir(this.config.dataDir, taskId), "out");
    const hits = await scanOutputsForKeyMaterial(outDir).catch((err) => {
      logger.warn({ err, taskId }, "Key-material leak scan failed; treating as clean");
      return [] as string[];
    });
    if (hits.length === 0) return true;
    logger.error({ taskId, hits }, "SECURITY: key material detected in scan outputs; quarantining (sync skipped)");
    await mergeTaskMetadata(taskId, {
      security_quarantine: { reason: "key_material_in_outputs", files: hits.length, at: new Date().toISOString() },
    }).catch(() => undefined);
    appendAndBroadcastCompletionEvent(taskId, {
      type: "error",
      source: "service",
      seq: 0,
      ts: new Date().toISOString(),
      code: "ERR_KEY_MATERIAL_LEAK",
      summary: "检测到产物中包含密钥材料，已按安全策略隔离（产物未回传）。",
    });
    return false;
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
        if (!(await this.guardNoKeyMaterialLeak(taskId))) continue;
        await syncOutputsToMinio(taskId, this.config, { includeDirs: INCREMENTAL_SYNC_DIRS });
        const count = await indexFindings(taskId, this.config.minio.bucket);
        notify({ type: "findings_indexed", taskId, count });
      } catch (err) {
        logger.warn({ err, taskId }, "Incremental findings index failed (non-fatal)");
      }
    }
  }

  private async prepareWorkspace(task: DbTask, token: string): Promise<boolean> {
    const hostWorkDir = getHostWorkDir(this.config.dataDir, task.id);
    const prepareDir = getSchedulerPrepareDir(hostWorkDir, token);
    const stagedSourceDir = join(prepareDir, "src");
    ensureWorkDir(hostWorkDir);
    await cleanupSchedulerWorkspace(hostWorkDir, token);
    ensureWorkDir(prepareDir);

    // Download and extract only inside the token-private tree.
    const archive = resolveArchiveIdentity({ taskId: task.id, sourceMeta: task.source_meta });
    const minioKey = archive.minioKey;
    const archivePath = join(prepareDir, "source-archive");
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
    await this.assertSchedulerOwnership(task.id, token);
    await extractSourceArchive(archivePath, archive.filename, stagedSourceDir, await getSourceArchivePolicy());
    await this.assertSchedulerOwnership(task.id, token);
    await publishSchedulerWorkspace(hostWorkDir, token);
    logger.info({ taskId: task.id, token, minioKey, filename: archive.filename }, "Claim-owned code package published to workspace");
    return true;
  }

  private async persistAuditCompletion(taskId: string, completion: TaskAuditCompletion): Promise<void> {
    const task = await getTaskById(taskId);
    const execution = task?.metadata?.execution;
    const existingWarning = execution && typeof execution === "object"
      ? (execution as Record<string, unknown>).warning
      : undefined;
    const warning = mergeExecutionWarnings(existingWarning, completion);
    const patch: import("@vulnhunter/shared").TaskMetadata = {
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
