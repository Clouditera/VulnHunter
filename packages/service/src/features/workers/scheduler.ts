/**
 * TaskScheduler: polls queued tasks every 5s, spawns workers up to max_parallel.
 * Also handles docker events (start/die/oom) to update task state.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { load as yamlLoad } from "js-yaml";

import { logger } from "../../infra/logger.js";
import { AppError } from "../../infra/app-error.js";
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
import { uploadSourceTreeToMinio, scheduleSrcTreeSync, flushSrcTreeSync } from "./src-tree-sync.js";
import { setEngineEventHandler } from "../events/event-tail.js";
import { cleanupSchedulerWorkspace, getSchedulerPrepareDir, publishSchedulerWorkspace } from "./scheduler-workspace.js";
import { isDynamicEnabled, persistedPrepareResult, parseGateYamlLenient, GATE_REASONS, type GateYaml, type PrepareResult } from "../prepare/contract.js";
import { armGateRouteHandler } from "./gate-perception.js";
import { getDynamicProvider, DynamicAllocationError } from "../dynamic/provider.js";
import { reconcileSchedulerClaims } from "./reconciler.js";
import { downloadObjectWithRetry } from "./minio-download.js";
import { getDefaultCredential, getCredentialById } from "../settings/storage.js";
import { CredentialDecryptError, CredentialKeyUnavailableError } from "../../infra/crypto/master-key-vault.js";
import { credentialToWorkerEnv, writeWorkerModelsJson } from "../settings/credential-env.js";
import { startTailing, stopTailing } from "../events/event-tail.js";
import { indexFindings } from "../findings/indexer.js";
import { syncOutputsToMinio, downloadOutputsFromMinio } from "./sync-outputs.js";
import { getMinio } from "../../infra/minio/client.js";
import { onChatContainerDie } from "../chat/chat-session.js";
import { appendAndBroadcastCompletionEvent } from "./scheduler-events.js";
import { onReportContainerDie } from "../reports/report-worker.js";
import { notify } from "../notifications/index.js";
import type { ServiceConfig } from "../../infra/config.js";
import { resolveArchiveIdentity } from "../source-archives/detect.js";
import { extractSourceArchive } from "../source-archives/extract.js";
import { getSourceArchivePolicy } from "../source-archives/policy.js";
import {
  hasPlatformTimeoutMarker,
  mapWorkerTerminalState,
  needsTerminalStateReconciliation,
} from "./audit-completion.js";

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
        // LEGACY (timeout finalizer retired 2026-08-18): historical logs from
        // the finalizer era contain two flow_end events; observed stage_done
        // events remain the authoritative cumulative count. Kept for old-log
        // compatibility only.
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

      if (event.taskType === "diagnostic") {
        logger.debug({ action, taskId, exitCode }, "Ignoring diagnostic container lifecycle event");
        return;
      }

      if (event.taskType !== "scan") return;

      logger.debug({ action, taskId, exitCode }, "Docker event");

      if (action === "die") {
        stopTailing(taskId);
        // source-files sync trigger c) task terminal: flush any pending or
        // in-flight src-tree sync so the final agent state is in MinIO before
        // the workspace gets cleaned up later (task-c069aab9).
        await flushSrcTreeSync(taskId).catch(() => undefined);

        // Check current DB state — if already cancelled/paused, don't overwrite
        const currentTask = await getTaskById(taskId);
        if (currentTask?.state === "preparing") {
          await this.handleDieDuringPreparing(taskId, claimToken ?? "", exitCode ?? -1, getHostWorkDir(this.config.dataDir, taskId));
          return;
        }
        // 终态守卫：gate END 等路径已完成判死/判终，die 不得覆盖终态（2.3.10 P0）。
        // Race: route handler fails the task (failed+completed_at), then the
        // container exits 0 (engine exit stage finishes before our stop);
        // without this guard exit-0 maps to completed and updateTaskState
        // (no WHERE-state predicate) overwrites failed.
        if (currentTask && (currentTask.state === "failed" || currentTask.state === "completed")) {
          logger.info({ taskId, dbState: currentTask.state, exitCode }, "Container died after terminal state; skipping overwrite");
          return;
        }
        if (currentTask && ["cancelled", "paused"].includes(currentTask.state)) {
          logger.info({ taskId, dbState: currentTask.state, exitCode }, "Container died but task already cancelled/paused, skipping state update");
          // Still sync outputs for cancelled tasks (may have partial results)
          if (currentTask.state === "cancelled") {
            await flushSrcTreeSync(taskId).catch(() => undefined);
            try {
              await syncOutputsToMinio(taskId, this.config);
            } catch (err) {
              logger.warn({ err, taskId }, "Failed to sync outputs on cancel");
            }
            await getDynamicProvider().stopSandboxForTask(taskId, "task_cancelled").catch(() => undefined);
          }
        } else {
          const workerExitCode = exitCode ?? -1;
          const ok = workerExitCode === 0;
          const hostWorkDir = getHostWorkDir(this.config.dataDir, taskId);
          // fish 2026-08-09: do NOT read completion.yaml. Terminal state is
          // exit code only; timeout posture is the platform marker file.
          const timedOut = hasPlatformTimeoutMarker(join(hostWorkDir, "out"));
          const mapped = mapWorkerTerminalState(workerExitCode, timedOut);

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
              completionReason: mapped.state === "completed" ? mapped.completionReason : "natural",
            }).catch((err) => logger.error({ err, taskId }, "Failed to update task on die"));
            notify({ type: "task_state", taskId, state: mapped.state });
            // H2 §4: terminal (completed/failed) — stop the sandbox, keep it.
            await getDynamicProvider().stopSandboxForTask(taskId, `task_${mapped.state}`).catch(() => undefined);
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

    // Incremental findings indexing for running tasks (before the capacity
    // early-return, since running>=max means capacity<=0 yet we still want
    // running tasks' findings to surface mid-scan).
    await this.tickIncrementalIndex().catch((err) =>
      logger.error({ err }, "Incremental index tick error"),
    );

    // H3 §3 (form A): platform fallback for a running task whose accounted
    // scan deadline is stuck (past deadline_at + SCAN_FALLBACK_MARGIN_S with
    // no terminal state). The worker normally self-terminates at its deadline
    // (scan-mode writes the timeout marker directly — finalizer retired
    // 2026-08-18); this only fires when the worker became unresponsive or its
    // clock was reset. Force-stop the container and let the claim-aware
    // die/terminal-reconcile path finalize the task as failed.
    await this.tickStuckDeadlineFallback().catch((err) =>
      logger.error({ err }, "Stuck-deadline fallback tick error"),
    );

    await reconcileSchedulerClaims(this.config).catch((err) =>
      logger.error({ err }, "Scheduler claim reconciliation failed"),
    );

    // H2 §5: incremental sandbox reconcile (full pass runs at service boot).
    if (Date.now() - this.lastSandboxReconcileAt >= SANDBOX_RECONCILE_INTERVAL_MS) {
      this.lastSandboxReconcileAt = Date.now();
      await getDynamicProvider().reconcileSandboxes().catch((err) =>
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
   * (H3 §3). Only acts when `now > deadline_at + SCAN_FALLBACK_MARGIN_S` —
   * past the deadline runner's grace window, so a responsive worker writing
   * its timeout marker + outputs is never killed mid-write. The container
   * stop triggers the normal docker die event, whose claim-aware handler runs
   * the terminal reconcile (task → failed, partial outputs preserved via
   * output-sync). No platform-injected finalizer exists (retired 2026-08-18).
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

      // Batch 2 (fish 2026-08-08): pre-generate models.json via the unified
      // module so the worker consumes a single source of truth.
      await writeWorkerModelsJson(cred, hostWorkDir);

      if (claim.mode === "continue") {
        published = await this.prepareWorkspace(task, token);
        await this.assertSchedulerOwnership(task.id, token);
        const downloaded = await downloadOutputsFromMinio(task.id, this.config);
        logger.info({ taskId: task.id, downloaded, token }, "Historical outputs restored for continue");
      } else if (claim.mode === "fresh") {
        published = await this.prepareWorkspace(task, token);
      }

      // Prepare phase (v2 — prepare internalized into the onboard gate):
      // - fresh: the scan worker starts IMMEDIATELY (dynamic tasks no longer
      //   wait for a sandbox); the onboard stage runs the gate and POSTs
      //   /internal/prepare-result, which allocates + injects into the
      //   running container and performs the preparing→running CAS. The
      //   scheduler only registers the gate watchdog (30min) and returns —
      //   task ownership for fresh claims effectively hands over to the
      //   callback route + reconciler.
      // - continue (task-c832309f): source is fixed — reuse
      //   metadata.prepare as the allocation basis (reused event kept for
      //   timeline explainability); only fall back to a hard failure when
      //   the persisted result is missing (the gate worker cannot re-run:
      //   its flow skips the gate on continue via the done marker).
      // - resume: paused container already has source and a completed gate;
      //   no gate, no prepare worker.
      if (claim.mode === "continue") {
        const prepareResult = await this.resolveContinuePrepare(task, token, hostWorkDir);
        await this.assertSchedulerOwnership(task.id, token);
        // H2 §3 path (continue/resume only): allocate BEFORE spawn.
        if (isDynamicEnabled(task) && prepareResult.sandbox_type) {
          await this.allocateSandboxForTask(task, token, prepareResult.sandbox_type);
          await this.assertSchedulerOwnership(task.id, token);
        }
      }

      await this.assertSchedulerOwnership(task.id, token);
      // --resume retired (fish 2026-08-20): YoungFlow checkpoint replay skips
      // done stages and replays frozen route decisions — on our cyclic
      // decide-flow that spins until GRAPH_RECURSION_LIMIT (prod batch, four
      // tasks). A respawned worker (claim mode "resume": paused task whose
      // container is gone) now runs --continue: fresh engine state, decide
      // re-evaluates reality, gate.yaml idempotently skips the gate.
      // Platform pause/resume semantics unchanged; docker-level unpause of a
      // still-frozen container never reaches this path.
      await spawnScanWorker(task, this.config, llmEnv, token, false, claim.mode === "continue" || claim.mode === "resume");
      workerStarted = true;

      if (claim.mode === "fresh") {
        // Emit prepare_started at worker start (event stream shape unchanged
        // from the retired prepare worker; web consumes as before).
        appendAndBroadcastCompletionEvent(task.id, {
          type: "prepare_started",
          source: "scan",
          seq: 0,
          ts: new Date().toISOString(),
          dynamic_enabled: isDynamicEnabled(task),
        });
        // Engine-native gate: the onboard stage routes natively via gate.yaml
        // (onboard.next==continue→cycle_join / ==end→exit). Perception rides
        // the existing EventTail engine-log pipeline (route events); this
        // scheduler registers the per-task handler. NO platform watchdog —
        // idle loops are capped in-engine by decide→onboard max_loops:5 and
        // hangs by the existing stuck-deadline fallback (fish 2026-08-19).
        this.registerGateRouteHandler(task.id, token, hostWorkDir);
        // Fresh claims do NOT markSchedulerClaimRunning here — the gate route
        // handler (or reconciler) completes preparing→running/failed.
        logger.info({ taskId: task.id, token }, "Fresh scan worker started; onboard gate routed in-engine");
        this.startFreshTailing(task.id, hostWorkDir);
        return;
      }
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

      // Tail ONLY the live stderr copy (.service-logs). The service.jsonl under
      // out/.youngflow/logs is a finalize-time COPY of the same stream — tailing
      // both replays the whole JSONL at copy time (every event twice, QA fbc08f1b).
      const serviceLogsDir = join(hostWorkDir, ".service-logs");
      try {
        startTailing(task.id, [], [{ path: serviceLogsDir, source: "scan" }]);
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
          await cleanupSchedulerWorkspace(hostWorkDir, token).catch(() => undefined);
          logger.info({ taskId: task.id, token }, "Claim requeued for sandbox allocation backoff");
          return;
        }
        logger.warn({ taskId: task.id, token }, "Requeue failed (claim lost?); falling through to normal failure path");
      }
      logger.error({ err, taskId: task.id, token }, "Claimed scan task failed");
      // Extract structured error info from AppError for the failure_reason.
      const failReason = err instanceof AppError
        ? JSON.stringify({ code: err.code, message: err.message, details: err.details })
        : String(err);
      const failed = await failSchedulerClaim(task.id, token, failReason).catch(() => false);
      if (failed) {
        await stopScanWorkerByClaim(task.id, token);
        // H2 §4: a sandbox allocated before the failure must not stay running.
        await getDynamicProvider().stopSandboxForTask(task.id, "claim_failed").catch(() => undefined);
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
      // NOTE: the fresh gate route handler intentionally survives this
      // method's return — the engine route event (or the reconciler's
      // checkpoint path) completes preparing→running/failed; the handler is
      // one-shot and detaches on its first terminal action.
      await cleanupSchedulerWorkspace(hostWorkDir, token).catch((err) =>
        logger.warn({ err, taskId: task.id, token }, "Failed to clean token-private scheduler workspace"),
      );
    }
  }


  /**
   * Continue-mode prepare resolution (task-c832309f): reuse the first-run
   * result persisted in metadata.prepare and emit a reused timeline event.
   * The retired live-prepare fallback is gone — the prepare worker no longer
   * exists, and the gate cannot re-run on continue (its done marker makes
   * the flow skip the submit). A missing/invalid persisted result is a hard
   * failure with a clear reason: re-create the task instead.
   */
  private async resolveContinuePrepare(
    task: ClaimedScanTask,
    token: string,
    _hostWorkDir: string,
  ): Promise<PrepareResult> {
    const persisted = (task.metadata as Record<string, unknown> | undefined)?.prepare;
    const result = persistedPrepareResult(persisted);

    if (!result) {
      logger.warn(
        { taskId: task.id, token, hasPrepareMeta: Boolean(persisted) },
        "Continue mode: metadata.prepare missing/invalid — cannot continue",
      );
      const remediation = "缺少首次运行的完整性判定结果，无法继续；请重新创建任务";
      appendAndBroadcastCompletionEvent(task.id, {
        type: "prepare_failed",
        source: "scan",
        seq: 0,
        ts: new Date().toISOString(),
        reason: "source_incomplete",
        remediation,
        reused: true,
      });
      throw new AppError("ERR_PREPARE_FAILED", {
        message: `源码不完整：功能代码缺失，无法建立完整的代码功能语义。审计目标应是自洽完整的功能项目（如 web 应用、CLI 应用、库）。${remediation}。`,
        details: { phase: "prepare", reason: "source_incomplete", remediation, reused: true },
      });
    }

    const dynamicEnabled = isDynamicEnabled(task);
    appendAndBroadcastCompletionEvent(task.id, {
      type: "prepare_completed",
      source: "scan",
      seq: 0,
      ts: new Date().toISOString(),
      project_complete: result.project_complete,
      sandbox_type: result.sandbox_type,
      reason: result.reason,
      reused: true,
    });
    logger.info(
      { taskId: task.id, token, result, dynamicEnabled },
      "Continue mode: reused first-run prepare result",
    );

    // Re-apply the branch matrix so a previously incomplete / no-sandbox
    // first run cannot silently proceed on continue.
    if (!result.project_complete) {
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
        reused: true,
      });
      throw new AppError("ERR_PREPARE_FAILED", {
        message: `源码不完整：功能代码缺失，无法建立完整的代码功能语义。审计目标应是自洽完整的功能项目（如 web 应用、CLI 应用、库）。${remediation}。`,
        details: { phase: "prepare", reason: "source_incomplete", remediation, reused: true },
      });
    }
    if (dynamicEnabled && result.sandbox_type === null) {
      const remediation = "关闭动态验证后重试，或联系管理员启用对应的沙箱类型";
      appendAndBroadcastCompletionEvent(task.id, {
        type: "prepare_failed",
        source: "scan",
        seq: 0,
        ts: new Date().toISOString(),
        reason: "no_compatible_sandbox",
        remediation,
        reused: true,
      });
      throw new AppError("ERR_PREPARE_FAILED", {
        message: `未找到兼容的沙箱类型（项目的主要运行方式没有可用的沙箱）。处理办法：${remediation}。`,
        details: { phase: "prepare", reason: "no_compatible_sandbox", remediation, reused: true },
      });
    }
    return result;
  }

  /**
   * Engine-native gate perception (spec §6): the onboard stage routes
   * natively via gate.yaml; youngflow emits `{category:"stage",
   * event:"route", stage:"onboard", target}` on the engine log, which the
   * EventTail pipeline delivers to this handler.
   *   target= cycle_join → gate passed → evidence gate → CAS running
   *   target= exit      → gate verdict END → read gate.yaml → fail claim
   * Bad/malformed events are tolerated (handler stays armed); the handler
   * detaches itself on the first terminal action.
   */
  private registerGateRouteHandler(taskId: string, token: string, hostWorkDir: string): void {
    armGateRouteHandler({
      taskId,
      token,
      hostWorkDir,
      onRoute: (target) => {
        this.handleGateRoute(taskId, token, hostWorkDir, target).catch((err) =>
          logger.error({ err, taskId, token, target }, "Gate route handling failed"),
        );
      },
    });
  }

  /**
   * die-during-preparing (engine-native gate): if gate.yaml carries an END
   * verdict, finalize through it; otherwise the flow died before producing
   * ANY verdict (reasoning model burned its output budget mid-thinking, QA
   * 6766220b) — fail with a human message + init_aborted event, exit code
   * kept in the text for triage (fish 2026-08-19 task ③).
   */
  async handleDieDuringPreparing(taskId: string, claimToken: string, exitCode: number, hostWorkDir: string): Promise<void> {
    const currentTask = await getTaskById(taskId).catch(() => null);
    if (!currentTask || currentTask.state !== "preparing") return;
    const claim = getSchedulerClaim(currentTask);
    if (!claim || claimToken !== claim.token) {
      logger.warn({ taskId, claimToken, currentToken: claim?.token }, "Ignoring stale-token scan die event during preparation");
      return;
    }
    // Gate terminal collection (spec §6): if the flow died around the
    // gate (max_loops exhausted → clean flow end, crash mid-gate),
    // gate.yaml carries the authoritative verdict when present.
    const gate = this.readGateYaml(hostWorkDir);
    if (gate?.next === "end") {
      this.finalizeGateEnd(taskId, claim.token, gate.reason, gate.detail, gate).catch((err) =>
        logger.error({ err, taskId }, "Gate END finalization on die failed"),
      );
      await cleanupSchedulerWorkspace(hostWorkDir, claim.token).catch(() => undefined);
      return;
    }
    const initAbortedMessage = `初始化未完成：引擎在准备阶段异常结束（退出码 ${exitCode}），未产出完整性判定结果。请重试；若反复出现请联系管理员。`;
    appendAndBroadcastCompletionEvent(taskId, {
      type: "prepare_failed",
      source: "scan",
      seq: 0,
      ts: new Date().toISOString(),
      reason: "init_aborted",
      remediation: initAbortedMessage,
    } as never);
    const failed = await failSchedulerClaim(taskId, claim.token, initAbortedMessage).catch(() => false);
    if (failed) {
      await stopScanWorkerByClaim(taskId, claim.token);
      await getDynamicProvider().stopSandboxForTask(taskId, "preparing_failed").catch(() => undefined);
      await cleanupSchedulerWorkspace(hostWorkDir, claim.token).catch(() => undefined);
      notify({ type: "task_state", taskId, state: "failed" });
    }
  }

  private async handleGateRoute(taskId: string, token: string, hostWorkDir: string, target: string): Promise<void> {
    const current = await getTaskById(taskId).catch(() => null);
    if (!current || current.state !== "preparing") return; // raced/repeat — idempotent
    const claim = getSchedulerClaim(current);
    if (!claim || claim.token !== token) return; // reconciler owns lost claims

    const gate = this.readGateYaml(hostWorkDir);

    if (target === "exit") {
      const reason = gate?.reason ?? "partial_source";
      const detail = gate?.detail;
      await this.finalizeGateEnd(taskId, token, reason, detail, gate);
      return;
    }

    // target === cycle_join": evidence gate (decide cannot self-authorize).
    const missing = this.checkGateEvidence(current, hostWorkDir);
    if (missing.length > 0) {
      logger.warn({ taskId, token, missing }, "Gate evidence missing; failing task");
      await this.finalizeGateEnd(taskId, token, "gate_evidence_missing" as never, `门禁证据缺失：${missing.join("、")}`, gate);
      return;
    }

    // Persist metadata.prepare (three-field contract kept for the timeline,
    // continue/resume reuse, and sandbox selection provenance).
    await mergeTaskMetadata(taskId, {
      prepare: {
        project_complete: true,
        sandbox_type: gate?.sandbox_type ?? null,
        reason: "complete",
        dynamic_enabled: isDynamicEnabled(current),
        at: new Date().toISOString(),
      },
    }).catch((err) => logger.warn({ err, taskId }, "Failed to persist prepare metadata at gate"));
    appendAndBroadcastCompletionEvent(taskId, {
      type: "prepare_completed",
      source: "scan",
      seq: 0,
      ts: new Date().toISOString(),
      project_complete: true,
      sandbox_type: gate?.sandbox_type ?? null,
      reason: "complete",
    });
    const marked = await markSchedulerClaimRunning(taskId, token, new Date());
    if (!marked) {
      logger.warn({ taskId, token }, "Gate CAS lost the claim (reconciler handles)");
      return;
    }
    notify({ type: "task_state", taskId, state: "running" });
    logger.info({ taskId, token }, "Onboard gate passed (engine route + evidence); task running");
    // source-files sync trigger a) gate passed: the gate handler was one-shot
    // and has disarmed — the engine-event slot is free. Arm the src-tree sync
    // watcher for every subsequent stage_done (covers the decompiled tree
    // written during onboard + all later agent edits under src/), plus one
    // immediate debounced sync so the tree appears without waiting a stage.
    setEngineEventHandler(taskId, (raw) => {
      if (raw.event === "stage_done" || raw.type === "stage_end") {
        scheduleSrcTreeSync(taskId, this.config);
      }
    });
    scheduleSrcTreeSync(taskId, this.config);
  }

  /**
   * Evidence gate (spec §0/§6, subsumes task-d9c73b59): continue requires
   * profiler.yaml + the three wiki files in out/knowledge/, non-empty;
   * dynamic tasks additionally require a recorded sandbox allocation
   * (metadata.sandbox_alloc — apply_sandbox succeeded).
   */
  private checkGateEvidence(task: DbTask, hostWorkDir: string): string[] {
    const missing: string[] = [];
    const outDir = join(hostWorkDir, "out");
    const required = [
      "knowledge/profiler.yaml",
      "knowledge/wiki/index.md",
      "knowledge/wiki/overview.md",
      "knowledge/wiki/threat-model.md",
    ];
    for (const rel of required) {
      const p = join(outDir, ...rel.split("/"));
      const ok = existsSync(p) && statSync(p).size > 0;
      if (!ok) missing.push(rel);
    }
    if (isDynamicEnabled(task)) {
      const alloc = ((task.metadata as Record<string, unknown> | undefined)?.sandbox_alloc ?? null) as { sandbox_id?: string } | null;
      if (!alloc?.sandbox_id) missing.push("sandbox_alloc（动态任务未申请沙箱）");
    }
    return missing;
  }

  /** Read + validate gate.yaml from the workspace; null on any miss.
   * Lenient (task-c4b8730c): a malformed file (unquoted detail) recovers the
   * routing verdict via top-line scan instead of reading as "no verdict". */
  private readGateYaml(hostWorkDir: string): GateYaml | null {
    try {
      const lenient = parseGateYamlLenient(readFileSync(join(hostWorkDir, "out", "gate.yaml"), "utf8"));
      if (lenient?.recovered) {
        logger.warn({ hostWorkDir }, "gate.yaml malformed, recovered next via line scan");
      }
      return lenient ? lenient.gate : null;
    } catch {
      return null;
    }
  }

  /** Terminal END path: persist prepare, emit prepare_failed, fail claim, stop worker. */
  private async finalizeGateEnd(
    taskId: string,
    token: string,
    reason: string,
    detail: string | undefined,
    gate: GateYaml | null,
  ): Promise<void> {
    const incomplete = reason === "partial_source" || reason === "fragment_collection";
    if (incomplete) {
      await mergeTaskMetadata(taskId, { source_incomplete: true }).catch(() => undefined);
    }
    await mergeTaskMetadata(taskId, {
      prepare: {
        project_complete: false,
        sandbox_type: gate?.sandbox_type ?? null,
        reason: (GATE_REASONS as readonly string[]).includes(reason) ? reason : "partial_source",
        at: new Date().toISOString(),
      },
    }).catch((err) => logger.warn({ err, taskId }, "Failed to persist prepare metadata at gate end"));

    const userReason =
      reason === "gate_evidence_missing" ? "gate_evidence_missing"
      : reason === "sandbox_unavailable" ? "sandbox_unavailable"
      : reason === "no_compatible_sandbox" ? "no_compatible_sandbox"
      : "source_incomplete";
    const remediationMap: Record<string, string> = {
      source_incomplete: "请补充完整项目源码后重新创建任务",
      no_compatible_sandbox: "关闭动态验证后重试，或联系管理员启用对应的沙箱类型",
      sandbox_unavailable: "稍后重试，或联系管理员检查沙箱服务容量/配额",
      gate_evidence_missing: "初始化产物校验未通过，请重试；若持续出现请联系管理员",
    };
    const remediation = remediationMap[userReason] ?? "请重试或联系管理员";
    appendAndBroadcastCompletionEvent(taskId, {
      type: "prepare_failed",
      source: "scan",
      seq: 0,
      ts: new Date().toISOString(),
      reason: userReason,
      remediation,
      ...(detail ? { detail } : {}),
    } as never);
    const failure = JSON.stringify({
      code: "ERR_PREPARE_FAILED",
      message: detail ?? `Onboard gate END（reason=${reason}）`,
      details: { phase: "prepare", reason, detail },
    });
    const failed = await failSchedulerClaim(taskId, token, failure).catch(() => false);
    if (failed) {
      await stopScanWorkerByClaim(taskId, token);
      await getDynamicProvider().stopSandboxForTask(taskId, "preparing_failed").catch(() => undefined);
      notify({ type: "task_state", taskId, state: "failed" });
    }
  }

  /** Event tailing for a fresh task in the gate phase (preparing state).
   * Tail failure is now a hard failure: the engine-log pipe is the ONLY
   * running gate-perception channel (spec §6) — a silent tail loss would
   * wedge the task until the stuck-deadline fallback. */
  private startFreshTailing(taskId: string, hostWorkDir: string): void {
    // Tail ONLY the live stderr copy (.service-logs) — the out/.youngflow/logs
    // copy is finalize-time only; tailing it replays every event (QA fbc08f1b).
    const serviceLogsDir = join(hostWorkDir, ".service-logs");
    try {
      startTailing(taskId, [], [{ path: serviceLogsDir, source: "scan" }]);
    } catch (err) {
      logger.error({ err, taskId }, "Fresh worker tailing failed to start — failing task (gate perception channel)");
      this.failFreshTailLoss(taskId).catch((e2) => logger.error({ err: e2, taskId }, "Tail-loss failure handling errored"));
    }
  }

  private async failFreshTailLoss(taskId: string): Promise<void> {
    const current = await getTaskById(taskId).catch(() => null);
    if (!current || current.state !== "preparing") return;
    const claim = getSchedulerClaim(current);
    if (!claim) return;
    const failure = JSON.stringify({
      code: "ERR_PREPARE_FAILED",
      message: "引擎事件管道启动失败，无法感知门禁状态",
      details: { phase: "prepare", reason: "event_tail_unavailable" },
    });
    const failed = await failSchedulerClaim(taskId, claim.token, failure).catch(() => false);
    if (failed) {
      await stopScanWorkerByClaim(taskId, claim.token);
      notify({ type: "task_state", taskId, state: "failed" });
    }
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
      const { mapping, reused } = await getDynamicProvider().ensureSandboxForTask(task, { profileId: sandboxType });
      await mergeTaskMetadata(task.id, {
        sandbox_alloc: { attempts: 0, next_attempt_at: null, sandbox_id: mapping.sandbox_id, profile_id: mapping.profile_id },
      }).catch((err) => logger.warn({ err, taskId: task.id }, "Failed to record sandbox_alloc metadata"));
      logger.info({ taskId: task.id, token, sandboxId: mapping.sandbox_id, reused }, "Sandbox ready for dynamic execution");
    } catch (error) {
      if (error instanceof DynamicAllocationError && (error.kind === "quota" || error.kind === "capacity")) {
        const attempts = (alloc.attempts ?? 0) + 1;
        const kind = error.kind;
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
    // source-files first-class tree (task-c069aab9): upload the extracted
    // tree once at prepare time — the viewer's authority. Fire-and-forget:
    // a failure only degrades to the legacy blob viewer, never blocks the task.
    void uploadSourceTreeToMinio(task.id, stagedSourceDir, this.config).catch((err) =>
      logger.warn({ err, taskId: task.id }, "source-files prepare upload failed"),
    );
    return true;
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
