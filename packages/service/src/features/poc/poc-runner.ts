/**
 * POC Runner — lightweight container to re-execute existing poc.sh scripts.
 * No LLM, no YoungFlow, no pi. Just runs the script and streams output.
 */

import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  createWorkerContainer,
  ensureWorkDir,
  getDocker,
} from "../workers/docker-client.js";
import { getMinio } from "../../infra/minio/client.js";
import * as pocStorage from "./storage.js";
import { logger } from "../../infra/logger.js";
import type { ServiceConfig } from "../../infra/config.js";

export function getRunHostWorkDir(dataDir: string, runId: string): string {
  return join(dataDir, "poc-run-workspaces", runId);
}

export async function spawnPocRunner(
  run: pocStorage.DbPocRun,
  config: ServiceConfig,
): Promise<string> {
  // Get POC result to find the script
  const result = await pocStorage.getPocResult(run.task_id, run.finding_key);
  if (!result?.poc_script_minio_key) {
    throw new Error(`No POC script for finding ${run.finding_key}`);
  }

  // Prepare workspace
  const hostWorkDir = getRunHostWorkDir(config.dataDir, run.id);
  ensureWorkDir(hostWorkDir);
  const eventsDir = join(hostWorkDir, "events");
  mkdirSync(eventsDir, { recursive: true });

  // Download poc.sh from MinIO
  const minio = getMinio();
  const scriptPath = join(hostWorkDir, "poc.sh");
  const stream = await minio.getObject(config.minio.bucket, result.poc_script_minio_key);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  writeFileSync(scriptPath, Buffer.concat(chunks));

  // Get POC settings for timeout
  const pocSettings = await pocStorage.getPocSettings();
  const timeout = pocSettings?.poc_timeout_s ?? 300;

  // Remove stale container
  const containerName = `vh-poc-run-${run.id}`;
  try {
    const docker = getDocker();
    await docker.getContainer(containerName).remove({ force: true });
  } catch { /* doesn't exist */ }

  const env: Record<string, string> = {
    MODE: "poc-run",
    TASK_ID: run.task_id,
    POC_RUN_ID: run.id,
    FINDING_KEY: run.finding_key,
    TARGET_URL: run.target_url ?? "",
    POC_TIMEOUT: String(timeout),
  };

  const container = await createWorkerContainer({
    taskId: run.id,
    taskType: "poc-run",
    image: config.docker.evalWorkerImage,
    network: config.docker.network,
    hostWorkDir,
    cpuQuota: 100000,
    memoryBytes: 1024 * 1024 * 1024,
    autoRemove: true,
    env,
  });

  await container.start();

  await pocStorage.updatePocRunState(run.id, "running", {
    containerId: container.id,
    startedAt: new Date(),
  });

  logger.info({ runId: run.id, findingKey: run.finding_key, containerName }, "POC runner started");
  return container.id;
}
