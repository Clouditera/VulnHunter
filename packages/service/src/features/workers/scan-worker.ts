import { join } from "node:path";
import type { ServiceConfig } from "../../infra/config.js";
import { logger } from "../../infra/logger.js";
import { updateTaskState } from "../tasks/storage.js";
import { notify } from "../notifications/index.js";
import {
  createWorkerContainer,
  ensureWorkDir,
  removeWorkDir,
  getDocker,
  LABEL_TASK_ID,
} from "./docker-client.js";

import type { DbTask } from "../tasks/storage.js";

export function getHostWorkDir(dataDir: string, taskId: string): string {
  return join(dataDir, "workspaces", taskId);
}

export async function spawnScanWorker(
  task: DbTask,
  config: ServiceConfig,
  llmEnv: Record<string, string>,
  resume = false,
): Promise<string> {
  const hostWorkDir = getHostWorkDir(config.dataDir, task.id);

  if (!resume) {
    ensureWorkDir(hostWorkDir);
  }

  // Remove stale container with same name if it exists (e.g. from previous failed run)
  try {
    const docker = getDocker();
    const old = docker.getContainer(`vh-scan-${task.id}`);
    await old.remove({ force: true });
  } catch { /* ok, doesn't exist */ }

  const container = await createWorkerContainer({
    taskId: task.id,
    taskType: "scan",
    image: config.docker.workerImage,
    network: config.docker.network,
    hostWorkDir,
    cpuQuota: 200000,
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
  notify({ type: "task_state", taskId: task.id, state: "running" });

  logger.info({ taskId: task.id, hostWorkDir, resume }, "Scan worker started");
  return container.id;
}

export async function stopScanWorker(taskId: string): Promise<void> {
  const docker = getDocker();
  const containers = await docker.listContainers({
    all: false,
    filters: JSON.stringify({ label: [`${LABEL_TASK_ID}=${taskId}`] }),
  });

  for (const info of containers) {
    try {
      const container = docker.getContainer(info.Id);
      await container.stop({ t: 30 });
      await container.remove({ force: true });
      logger.info({ taskId, containerId: info.Id }, "Scan worker stopped and removed");
    } catch (err) {
      logger.warn({ err, taskId }, "Failed to stop worker container");
    }
  }
}

export function cleanupScanWorkDir(dataDir: string, taskId: string): void {
  removeWorkDir(getHostWorkDir(dataDir, taskId));
}
