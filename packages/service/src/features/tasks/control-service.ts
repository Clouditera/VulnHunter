import { getMinio } from "../../infra/minio/client.js";
import { loadConfig, type ServiceConfig } from "../../infra/config.js";
import { logger } from "../../infra/logger.js";
import { notify } from "../notifications/index.js";
import { cleanupScanWorkDir, getHostWorkDir, stopScanWorker, stopScanWorkerByClaim, pauseScanWorker, unpauseScanWorker } from "../workers/scan-worker.js";
import { stopSandboxForTask, resumeSandboxForTask } from "../sandboxes/lifecycle.js";
import { cleanupSchedulerWorkspace } from "../workers/scheduler-workspace.js";
import { assertNoActiveOperation } from "./operation-lock.js";
import {
  cancelSchedulerClaim,
  getSchedulerClaim,
  getTaskById,
  queueTaskForResume,
  queueTaskForContinue,
  resetTaskForRestart,
  updateTaskState,
  type DbTask,
} from "./storage.js";

export interface TaskControlResult {
  ok: true;
  task: DbTask;
  state: "cancelled" | "paused" | "queued";
}

export class TaskControlError extends Error {
  constructor(
    public readonly code: "ERR_TASK_NOT_FOUND" | "ERR_INVALID_STATE" | "ERR_TASK_BUSY",
    message: string,
    public readonly status = code === "ERR_TASK_NOT_FOUND" ? 404 : 409,
    public readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "TaskControlError";
  }
}

async function requireTask(taskId: string): Promise<DbTask> {
  const task = await getTaskById(taskId);
  if (!task) throw new TaskControlError("ERR_TASK_NOT_FOUND", "Task not found", 404);
  return task;
}

function invalidState(message: string): never {
  throw new TaskControlError("ERR_INVALID_STATE", message, 409);
}

async function assertScanNotBusy(taskId: string): Promise<void> {
  try {
    await assertNoActiveOperation(taskId, "scan");
  } catch (err: any) {
    if (err?.code === "ERR_TASK_BUSY") {
      throw new TaskControlError("ERR_TASK_BUSY", err.message, 409, { active: err.active });
    }
    throw err;
  }
}

export async function cancelTask(taskId: string): Promise<TaskControlResult> {
  const task = await requireTask(taskId);
  if (!["running", "paused", "queued", "preparing"].includes(task.state)) {
    invalidState(`Task ${task.project_name} is in state '${task.state}' and cannot be cancelled.`);
  }
  await assertScanNotBusy(task.id);
  const claim = task.state === "preparing" ? getSchedulerClaim(task) : null;
  if (claim) {
    if (!await cancelSchedulerClaim(task.id, claim.token)) invalidState("Task preparation ownership changed; retry cancellation.");
    await stopScanWorkerByClaim(task.id, claim.token).catch((err) => {
      logger.warn({ err, taskId: task.id, token: claim.token }, "Failed to stop claim Worker on cancel");
    });
    const config = loadConfig();
    await cleanupSchedulerWorkspace(getHostWorkDir(config.dataDir, task.id), claim.token).catch((err) => {
      logger.warn({ err, taskId: task.id, token: claim.token }, "Failed to clean claim workspace on cancel");
    });
  } else {
    await updateTaskState(task.id, "cancelled", { completedAt: new Date() });
  }
  // Both running and paused (docker-frozen) tasks have a live container to tear down.
  if (task.state === "running" || task.state === "paused") {
    await stopScanWorker(task.id).catch((err) => {
      logger.warn({ err, taskId: task.id }, "Failed to stop container on cancel");
    });
  }
  // H2 §4: cancelled — stop the sandbox, keep it (release happens on delete).
  await stopSandboxForTask(task.id, "task_cancelled").catch((err) =>
    logger.warn({ err, taskId: task.id }, "Failed to stop sandbox on cancel"),
  );
  notify({ type: "task_state", taskId: task.id, state: "cancelled" });
  return { ok: true, task, state: "cancelled" };
}

export async function pauseTask(taskId: string): Promise<TaskControlResult> {
  const task = await requireTask(taskId);
  if (task.state !== "running") invalidState("Task is not running");
  await assertScanNotBusy(task.id);
  // Freeze the container in place (docker pause) instead of killing the worker.
  // VulnForge is a cyclic flow; YoungFlow's --resume cannot restore loop stages
  // (YoungFlow issue #27), so we preserve full process state and unpause on
  // resume. Fall back to stop only if no container was actually paused.
  const paused = await pauseScanWorker(task.id).catch((err) => {
    logger.warn({ err, taskId: task.id }, "Failed to pause worker container");
    return 0;
  });
  if (paused === 0) {
    logger.warn({ taskId: task.id }, "No scan container paused; falling back to stop");
    await stopScanWorker(task.id).catch((err) => {
      logger.warn({ err, taskId: task.id }, "Failed to stop worker on pause fallback");
    });
  }
  await updateTaskState(task.id, "paused");
  // H2 §4: paused — stop the sandbox, keep it (resumed on task resume).
  await stopSandboxForTask(task.id, "task_paused").catch((err) =>
    logger.warn({ err, taskId: task.id }, "Failed to stop sandbox on pause"),
  );
  notify({ type: "task_state", taskId: task.id, state: "paused" });
  return { ok: true, task, state: "paused" };
}

export async function resumeTask(taskId: string): Promise<TaskControlResult> {
  const task = await requireTask(taskId);
  if (task.state !== "paused") invalidState("Task is not paused");
  // H2 §4: a stopped sandbox must be running again before the worker
  // continues — fail loud and keep the task paused when it cannot come back.
  await resumeSandboxForTask(taskId);
  // Prefer unpausing the frozen container in place. If it is still present we
  // simply continue execution and go straight back to running. Only when no
  // paused container exists (e.g. service restarted, container gone) do we fall
  // back to the scheduler-driven respawn (`--continue`; --resume retired
  // 2026-08-20 — checkpoint replay spins on cyclic flows).
  const unpaused = await unpauseScanWorker(task.id).catch((err) => {
    logger.warn({ err, taskId: task.id }, "Failed to unpause worker container");
    return 0;
  });
  if (unpaused > 0) {
    await updateTaskState(task.id, "running");
    notify({ type: "task_state", taskId: task.id, state: "running" });
    return { ok: true, task, state: "queued" };
  }
  logger.warn({ taskId: task.id }, "No paused container to unpause; falling back to --continue");
  await queueTaskForResume(task.id);
  notify({ type: "task_state", taskId: task.id, state: "queued" });
  return { ok: true, task, state: "queued" };
}

/**
 * CONTINUE a completed/failed/cancelled task: re-run VulnForge with `--continue`
 * on top of the existing outputs. Unlike restart, this preserves findings_meta
 * and MinIO scan-outputs; the scheduler downloads the historical outputs back
 * into the worker workspace and YoungFlow archives the prior engine state to
 * begin a fresh deepening round. Optionally overrides audit_focus / scan_timeout.
 */
export async function continueTask(
  taskId: string,
  params?: { auditFocus?: string; scanTimeout?: number },
): Promise<TaskControlResult> {
  const task = await requireTask(taskId);
  if (!["completed", "failed", "cancelled"].includes(task.state)) {
    invalidState("Can only continue completed/failed/cancelled tasks");
  }
  await assertScanNotBusy(task.id);
  await queueTaskForContinue(task.id, params);
  notify({ type: "task_state", taskId: task.id, state: "queued" });
  return { ok: true, task, state: "queued" };
}

export async function restartTask(
  taskId: string,
  config: ServiceConfig = loadConfig(),
): Promise<TaskControlResult> {
  const task = await requireTask(taskId);
  if (!["failed", "cancelled", "completed"].includes(task.state)) {
    invalidState("Cannot restart in current state");
  }

  await assertScanNotBusy(task.id);

  await resetTaskForRestart(task.id);
  cleanupScanWorkDir(config.dataDir, task.id, config.docker.workerImage);

  try {
    const minio = getMinio();
    const prefix = `scan-outputs/${task.id}/`;
    const objects = await new Promise<string[]>((resolve, reject) => {
      const keys: string[] = [];
      const stream = minio.listObjects(config.minio.bucket, prefix, true);
      stream.on("data", (obj) => { if (obj.name) keys.push(obj.name); });
      stream.on("end", () => resolve(keys));
      stream.on("error", reject);
    });
    if (objects.length > 0) await minio.removeObjects(config.minio.bucket, objects);
  } catch (err) {
    logger.warn({ err, taskId: task.id }, "Failed to cleanup MinIO scan-outputs on restart");
  }

  notify({ type: "task_state", taskId: task.id, state: "queued" });
  return { ok: true, task, state: "queued" };
}
