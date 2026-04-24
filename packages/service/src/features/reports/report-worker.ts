/**
 * Report Worker — spawns one-shot container to generate a report.
 *
 * Same Docker image as scan/chat, MODE=report. Pi runs with --skill
 * and exits after generating report files.
 */

import { join } from "node:path";
import { mkdirSync } from "node:fs";
import {
  createWorkerContainer,
  ensureWorkDir,
  getDocker,
} from "../workers/docker-client.js";
import { getDefaultCredential, getCredentialById } from "../settings/storage.js";
import { credentialToWorkerEnv } from "../settings/credential-env.js";
import { getSkill, updateReportStatus, getReport } from "./storage.js";
import { getMinio } from "../../infra/minio/client.js";
import { notify } from "../notifications/index.js";
import { logger } from "../../infra/logger.js";
import type { ServiceConfig } from "../../infra/config.js";

export async function spawnReportWorker(params: {
  taskId: string;
  reportId: string;
  skillId: string;
  credentialId?: string;
  createdBy: string;
  config: ServiceConfig;
}): Promise<string> {
  const { taskId, reportId, skillId, config } = params;

  // Get skill
  const skill = await getSkill(skillId);
  if (!skill) throw new Error("Skill not found");

  // Get credentials
  const cred = params.credentialId
    ? await getCredentialById(params.credentialId)
    : await getDefaultCredential();
  if (!cred) throw new Error("No LLM credentials configured");

  // Prepare workspace
  const hostWorkDir = join(config.dataDir, "report-workspaces", reportId);
  ensureWorkDir(hostWorkDir);
  const skillDir = join(hostWorkDir, "skill");
  mkdirSync(skillDir, { recursive: true });
  const reportsDir = join(hostWorkDir, "reports");
  mkdirSync(reportsDir, { recursive: true });

  // Download skill zip from MinIO to host
  const minio = getMinio();
  const skillZipPath = join(hostWorkDir, "skill.zip");
  await minio.fGetObject(config.minio.bucket, skill.minio_key, skillZipPath);

  // Extract skill zip
  const { execSync } = await import("node:child_process");
  execSync(`cd "${skillDir}" && unzip -o -q "${skillZipPath}"`, { timeout: 30_000, stdio: "pipe" });
  logger.info({ reportId, skillId, skillDir }, "Report skill extracted");

  const containerName = `vh-report-${reportId.slice(0, 12)}`;

  // Remove stale container
  try {
    const docker = getDocker();
    await docker.getContainer(containerName).remove({ force: true });
  } catch { /* doesn't exist */ }

  const env: Record<string, string> = {
    MODE: "report",
    TASK_ID: taskId,
    REPORT_ID: reportId,
    SKILL_PATH: "/workspace/skill",
    REPORTS_DIR: "/workspace/reports",
    ...credentialToWorkerEnv(cred),
    SERVICE_URL: `http://vulnhunt-service:${config.port}`,
    CHAT_WORKER_TOKEN: reportId, // MCP auth token
    REPORT_SYSTEM_PROMPT: [
      "你是安全报告生成助手。",
      "你已被加载了一个 Report Skill（通过 --skill 参数），它定义了报告的格式、语言、内容结构和评估标准。",
      "严格按照 Skill 的指引生成报告。不要发明 Skill 未要求的内容格式。",
      `使用 MCP 工具（list-findings, read-finding, read-task-metadata）获取任务 ${taskId} 的数据。`,
      "将报告文件写入 /workspace/reports/，完成后调用 submit-report 提交。",
    ].join("\n"),
  };

  const container = await createWorkerContainer({
    taskId: reportId,
    taskType: "report",
    image: config.docker.workerImage,
    network: config.docker.network,
    hostWorkDir,
    cpuQuota: 100000,
    memoryBytes: 2 * 1024 * 1024 * 1024,
    autoRemove: true,
    env,
  });

  await container.start();
  logger.info({ reportId, taskId, containerName }, "Report worker started");
  return container.id;
}

/**
 * Handle report worker container die event.
 * If submit_report was called (status already completed), nothing to do.
 * Otherwise mark as failed.
 */
export async function onReportContainerDie(
  reportId: string,
  exitCode: number | undefined,
): Promise<void> {
  const report = await getReport(reportId);
  if (!report) return;

  // If already completed by submit_report MCP call, skip
  if (report.status === "completed") {
    logger.info({ reportId }, "Report already completed (submit_report called)");
    return;
  }

  if (exitCode === 0) {
    // Pi exited cleanly but didn't call submit_report — try to salvage
    // by checking if files exist in workspace
    logger.warn({ reportId }, "Report worker exited 0 but submit_report not called");
    await updateReportStatus(reportId, "failed", {
      failureReason: "Worker exited without submitting report",
    });
  } else {
    await updateReportStatus(reportId, "failed", {
      failureReason: `Worker exited with code ${exitCode}`,
    });
  }

  notify({ type: "task_state", taskId: report.task_id, state: "completed" as never });
  logger.info({ reportId, exitCode }, "Report worker died");
}
