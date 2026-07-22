/**
 * Eval Worker — spawns youngflow POC flow container to generate + execute POCs.
 * Uses vulnhunter-eval-worker image with MODE=eval.
 */

import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  createWorkerContainer,
  ensureWorkDir,
  getDocker,
} from "../workers/docker-client.js";
import { getDefaultCredential, getCredentialById } from "../settings/storage.js";
import { CredentialDecryptError, CredentialKeyUnavailableError } from "../../infra/crypto/master-key-vault.js";
import { credentialToWorkerEnv } from "../settings/credential-env.js";
import { getMinio } from "../../infra/minio/client.js";
import { getTaskById } from "../tasks/storage.js";
import { listFindings } from "../findings/storage.js";
import * as pocStorage from "./storage.js";
import { notify } from "../notifications/index.js";
import { logger } from "../../infra/logger.js";
import type { ServiceConfig } from "../../infra/config.js";
import { resolveArchiveIdentity } from "../source-archives/detect.js";
import { extractSourceArchive, prepareSourceArchiveDestination } from "../source-archives/extract.js";
import { getSourceArchivePolicy } from "../source-archives/policy.js";

export function getEvalHostWorkDir(dataDir: string, jobId: string): string {
  return join(dataDir, "eval-workspaces", jobId);
}

export async function spawnEvalWorker(
  job: pocStorage.DbPocJob,
  config: ServiceConfig,
): Promise<string> {
  const task = await getTaskById(job.task_id);
  if (!task) throw new Error(`Task ${job.task_id} not found`);

  // Get credentials — job-level > default
  let cred;
  try {
    cred = job.credential_id
      ? await getCredentialById(job.credential_id)
      : await getDefaultCredential();
  } catch (err) {
    if (err instanceof CredentialKeyUnavailableError) {
      throw new Error("凭证加密 key 未配置。请管理员设置 VULNHUNTER_MASTER_KEY_FILE 并重启服务，或挂载正确的 master key 文件。");
    }
    if (err instanceof CredentialDecryptError) {
      throw new Error("LLM credential cannot be decrypted with current master key. Re-save the credential in Settings or restore the original master key.");
    }
    throw err;
  }
  if (!cred) throw new Error("No LLM credentials configured");

  // Prepare workspace
  const hostWorkDir = getEvalHostWorkDir(config.dataDir, job.id);
  ensureWorkDir(hostWorkDir);
  const subjectDir = join(hostWorkDir, "subject");
  const outDir = join(hostWorkDir, "out");
  mkdirSync(outDir, { recursive: true });
  const inputFindingsDir = join(outDir, "input", "findings");
  mkdirSync(inputFindingsDir, { recursive: true });
  const logsDir = join(outDir, ".youngflow", "logs");
  mkdirSync(logsDir, { recursive: true });

  // Download source code from MinIO
  const archive = resolveArchiveIdentity({ taskId: task.id, sourceMeta: task.source_meta });
  const minio = getMinio();
  const archivePath = join(hostWorkDir, "source-archive");
  await minio.fGetObject(config.minio.bucket, archive.minioKey, archivePath);
  prepareSourceArchiveDestination(subjectDir);
  await extractSourceArchive(archivePath, archive.filename, subjectDir, await getSourceArchivePolicy());

  // Stage selected findings as YAML files into input/findings/
  const allFindings = await listFindings({ taskId: job.task_id });
  for (const finding of allFindings) {
    if (!job.finding_keys.includes(finding.finding_key)) continue;
    try {
      const stream = await minio.getObject(config.minio.bucket, finding.yaml_minio_key);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      writeFileSync(
        join(inputFindingsDir, `${finding.finding_key}.yaml`),
        Buffer.concat(chunks),
      );
    } catch (err) {
      logger.warn({ err, findingKey: finding.finding_key }, "Failed to stage finding YAML");
    }
  }
  logger.info({ jobId: job.id, findings: job.finding_keys.length }, "Findings staged to workspace");

  // Get POC settings for DeVeye config
  const pocSettings = await pocStorage.getPocSettings();

  // Remove stale container (name matches createWorkerContainer format)
  const containerName = `va-eval-${job.id}`;
  try {
    const docker = getDocker();
    await docker.getContainer(containerName).remove({ force: true });
  } catch { /* doesn't exist */ }

  const llmEnv = credentialToWorkerEnv(cred);

  const env: Record<string, string> = {
    MODE: "eval",
    TASK_ID: job.task_id,
    POC_JOB_ID: job.id,
    TARGET_MODE: job.target_mode,
    TARGET_URL: job.target_url ?? "",
    BROWSER_TOOL: job.browser_tool,
    CUSTOM_INSTRUCTIONS: job.custom_instructions ?? "",
    DEVEYE_SERVER: job.deveye_server_url || pocSettings?.deveye_server_url || "",
    DEVEYE_TOKEN: job.deveye_token || pocSettings?.deveye_token || "",
    ...llmEnv,
  };

  // Docker socket mount for auto_deploy mode
  const extraMounts: Array<{ Type: "bind"; Source: string; Target: string }> = [];
  if (job.target_mode === "auto_deploy") {
    extraMounts.push({
      Type: "bind",
      Source: "/var/run/docker.sock",
      Target: "/var/run/docker.sock",
    });
  }

  const container = await createWorkerContainer({
    taskId: job.id,
    taskType: "eval",
    image: config.docker.evalWorkerImage,
    network: pocSettings?.container_network_mode === "host" ? "host" : config.docker.network,
    hostWorkDir,
    cpuQuota: 200000,
    memoryBytes: 4 * 1024 * 1024 * 1024,
    env,
    extraMounts,
  });

  await container.start();

  await pocStorage.updatePocJobState(job.id, "running", {
    containerId: container.id,
    startedAt: new Date(),
  });
  notify({ type: "task_state", taskId: job.task_id, state: "running" as never });

  logger.info({ jobId: job.id, taskId: job.task_id, containerName }, "Eval worker started");
  return container.id;
}
