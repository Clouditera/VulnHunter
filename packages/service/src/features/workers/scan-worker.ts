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
  LABEL_TASK_TYPE,
} from "./docker-client.js";

import type { DbTask } from "../tasks/storage.js";

export const STATIC_ONLY_SCHED_INSTR = "平台策略：本次仅执行静态审计；不得选择 poc-verify 或 exp-build；完成静态审计后进入报告阶段。";

export function assertDynamicInputPolicy(enablePoc: boolean, enableExp: boolean, sandboxCfg?: string): void {
  if (enableExp && !enablePoc) throw new Error("enable_exp requires enable_poc");
  if ((enablePoc || enableExp) && !sandboxCfg?.trim()) {
    throw new Error("dynamic verification requires a validated sandbox_cfg");
  }
}

function optionalTextMeta(meta: DbTask["source_meta"] | null | undefined, key: string): string {
  const value = meta?.[key];
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  if (normalized.includes("\0")) throw new Error(`Invalid NUL in task metadata: ${key}`);
  return normalized;
}

export function scanInputEnvFromMeta(meta: DbTask["source_meta"] | null | undefined): Record<string, string> {
  const canonicalUserInstr = optionalTextMeta(meta, "user_instr");
  return {
    VULNFORGE_AUDIT_SCOPE: optionalTextMeta(meta, "audit_scope"),
    VULNFORGE_VULN_FOCUS: optionalTextMeta(meta, "vuln_focus"),
    VULNFORGE_SCHED_INSTR: STATIC_ONLY_SCHED_INSTR,
    VULNFORGE_USER_INSTR: canonicalUserInstr || optionalTextMeta(meta, "audit_focus"),
  };
}

export function getHostWorkDir(dataDir: string, taskId: string): string {
  return join(dataDir, "workspaces", taskId);
}

export async function spawnScanWorker(
  task: DbTask,
  config: ServiceConfig,
  llmEnv: Record<string, string>,
  resume = false,
  continueMode = false,
): Promise<string> {
  const hostWorkDir = getHostWorkDir(config.dataDir, task.id);

  if (!resume && !continueMode) {
    ensureWorkDir(hostWorkDir);
  }

  // Remove stale container with same name if it exists (e.g. from previous failed run)
  try {
    const docker = getDocker();
    const old = docker.getContainer(`va-scan-${task.id}`);
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
      ...llmEnv,
      MODE: "scan",
      TASK_ID: task.id,
      RESUME: resume ? "1" : "0",
      CONTINUE: continueMode ? "1" : "0",
      ...scanInputEnvFromMeta(task.source_meta),
      SCAN_TIMEOUT: stringMeta(task.source_meta, "scan_timeout"),
      MAX_ITEMS_PER_RECON: stringMeta(task.source_meta, "max_items_per_recon"),
      RECURSION_LIMIT: stringMeta(task.source_meta, "recursion_limit"),
      MINIO_ENDPOINT: `http://${config.minio.endpoint}:${config.minio.port}`,
      MINIO_ACCESS_KEY: config.minio.accessKey,
      MINIO_SECRET_KEY: config.minio.secretKey,
      MINIO_BUCKET: config.minio.bucket,
      SERVICE_URL: config.docker.workerServiceUrl,
    },
  });

  await container.start();
  await updateTaskState(task.id, "running", { startedAt: new Date() });
  notify({ type: "task_state", taskId: task.id, state: "running" });

  logger.info({ taskId: task.id, hostWorkDir, resume, continueMode }, "Scan worker started");
  return container.id;
}

function stringMeta(meta: DbTask["source_meta"] | null | undefined, key: string): string {
  const value = meta?.[key];
  if (value === undefined || value === null) return "";
  return String(value);
}

export async function stopScanWorker(taskId: string): Promise<void> {
  const docker = getDocker();
  const containers = await docker.listContainers({
    all: false,
    filters: JSON.stringify({ label: [`${LABEL_TASK_ID}=${taskId}`, `${LABEL_TASK_TYPE}=scan`] }),
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

/**
 * Freeze the running scan container in place (SIGSTOP via the Docker freezer
 * cgroup). Unlike stop+resume, this preserves full process/memory state, which
 * is required for VulnForge's cyclic flow — YoungFlow's checkpoint `--resume`
 * cannot correctly restore loop stages (see YoungFlow issue #27). Returns the
 * number of containers paused.
 */
export async function pauseScanWorker(taskId: string): Promise<number> {
  const docker = getDocker();
  const containers = await docker.listContainers({
    all: false,
    filters: JSON.stringify({ label: [`${LABEL_TASK_ID}=${taskId}`, `${LABEL_TASK_TYPE}=scan`] }),
  });
  let paused = 0;
  for (const info of containers) {
    try {
      await docker.getContainer(info.Id).pause();
      paused++;
      logger.info({ taskId, containerId: info.Id }, "Scan worker paused (docker pause)");
    } catch (err) {
      logger.warn({ err, taskId }, "Failed to pause worker container");
    }
  }
  return paused;
}

/**
 * Resume a previously frozen scan container (docker unpause). Includes paused
 * containers in the listing since a paused container is still "running" but we
 * keep `all: true` for safety. Returns the number of containers unpaused.
 */
export async function unpauseScanWorker(taskId: string): Promise<number> {
  const docker = getDocker();
  const containers = await docker.listContainers({
    all: true,
    filters: JSON.stringify({ label: [`${LABEL_TASK_ID}=${taskId}`, `${LABEL_TASK_TYPE}=scan`] }),
  });
  let unpaused = 0;
  for (const info of containers) {
    // Only attempt unpause on containers actually in the paused state.
    if (info.State !== "paused" && !/\(Paused\)/i.test(info.Status ?? "")) continue;
    try {
      await docker.getContainer(info.Id).unpause();
      unpaused++;
      logger.info({ taskId, containerId: info.Id }, "Scan worker unpaused (docker unpause)");
    } catch (err) {
      logger.warn({ err, taskId }, "Failed to unpause worker container");
    }
  }
  return unpaused;
}

export function cleanupScanWorkDir(dataDir: string, taskId: string, cleanupImage?: string): void {
  removeWorkDir(getHostWorkDir(dataDir, taskId), cleanupImage);
}
