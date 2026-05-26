import { getMinio } from "../../infra/minio/client.js";
import { loadConfig, type ServiceConfig } from "../../infra/config.js";
import { logger } from "../../infra/logger.js";
import { notify } from "../notifications/index.js";
import { cleanupScanWorkDir, stopScanWorker } from "../workers/scan-worker.js";
import { assertNoActiveOperation } from "./operation-lock.js";
import {
  getTaskById,
  queueTaskForResume,
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
  if (!["running", "paused", "queued"].includes(task.state)) {
    invalidState(`Task ${task.project_name} is in state '${task.state}' and cannot be cancelled.`);
  }
  await assertScanNotBusy(task.id);
  await updateTaskState(task.id, "cancelled", { completedAt: new Date() });
  if (task.state === "running") {
    await stopScanWorker(task.id).catch((err) => {
      logger.warn({ err, taskId: task.id }, "Failed to stop container on cancel");
    });
  }
  notify({ type: "task_state", taskId: task.id, state: "cancelled" });
  return { ok: true, task, state: "cancelled" };
}

export async function pauseTask(taskId: string): Promise<TaskControlResult> {
  const task = await requireTask(taskId);
  if (task.state !== "running") invalidState("Task is not running");
  await assertScanNotBusy(task.id);
  await updateTaskState(task.id, "paused");
  await stopScanWorker(task.id).catch((err) => {
    logger.warn({ err, taskId: task.id }, "Failed to stop worker on pause");
  });
  notify({ type: "task_state", taskId: task.id, state: "paused" });
  return { ok: true, task, state: "paused" };
}

export async function resumeTask(taskId: string): Promise<TaskControlResult> {
  const task = await requireTask(taskId);
  if (task.state !== "paused") invalidState("Task is not paused");
  await queueTaskForResume(task.id);
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
