import type { ServiceConfig } from "../../infra/config.js";
import { logger } from "../../infra/logger.js";
import { updateTaskState } from "../tasks/storage.js";
import {
  createWorkerContainer,
  ensureVolume,
  removeVolume,
} from "./docker-client.js";
import type { DbTask } from "../tasks/storage.js";

export async function spawnScanWorker(
  task: DbTask,
  config: ServiceConfig,
  llmEnv: Record<string, string>,
  resume = false,
): Promise<string> {
  const volumeName = `vh-task-${task.id}`;

  if (!resume) {
    await ensureVolume(volumeName);
  }

  const container = await createWorkerContainer({
    taskId: task.id,
    taskType: "scan",
    image: config.docker.workerImage,
    network: config.docker.network,
    volumeName,
    cpuQuota: 200000, // 2 CPU
    memoryBytes: 4 * 1024 * 1024 * 1024,
    env: {
      MODE: "scan",
      TASK_ID: task.id,
      RESUME: resume ? "1" : "0",
      MINIO_ENDPOINT: `http://${config.minio.endpoint}:${config.minio.port}`,
      MINIO_ACCESS_KEY: config.minio.accessKey,
      MINIO_SECRET_KEY: config.minio.secretKey,
      MINIO_BUCKET: config.minio.bucket,
      SERVICE_URL: `http://vulnhunt-service:${config.port}`,
      ...llmEnv,
    },
  });

  await container.start();
  await updateTaskState(task.id, "running", { startedAt: new Date() });

  logger.info({ taskId: task.id, resume }, "Scan worker started");
  return container.id;
}

export async function stopScanWorker(taskId: string): Promise<void> {
  // Container kill handled by TaskScheduler via docker events
  // This is called for pause/cancel — signal the container
  logger.info({ taskId }, "Stopping scan worker");
}

export async function cleanupScanVolume(taskId: string): Promise<void> {
  await removeVolume(`vh-task-${taskId}`);
}
