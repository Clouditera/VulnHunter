/**
 * Report Worker — spawns YoungFlow report flow in container.
 *
 * Service generates context JSON with findings data, injects uploaded
 * Report Skill, runs YoungFlow. On completion, reads manifest and
 * uploads report files to MinIO.
 */

import { join } from "node:path";
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import {
  createWorkerContainer,
  ensureWorkDir,
  getDocker,
} from "../workers/docker-client.js";
import { getDefaultCredential, getCredentialById } from "../settings/storage.js";
import { CredentialDecryptError, CredentialKeyUnavailableError } from "../../infra/crypto/master-key-vault.js";
import { credentialToWorkerEnv } from "../settings/credential-env.js";
import { getSkill, updateReportStatus, getReport } from "./storage.js";
import { getMinio } from "../../infra/minio/client.js";
import { notify } from "../notifications/index.js";
import { logger } from "../../infra/logger.js";
import { getTaskById } from "../tasks/storage.js";
import { getDb } from "../../infra/db/client.js";
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

  const skill = await getSkill(skillId);
  if (!skill) throw new Error("Skill not found");

  let cred;
  try {
    cred = params.credentialId
      ? await getCredentialById(params.credentialId)
      : await getDefaultCredential();
  } catch (err) {
    if (err instanceof CredentialKeyUnavailableError) {
      throw new Error("凭证加密 key 未配置。请管理员设置 VULNAGENT_MASTER_KEY_FILE 并重启服务，或挂载正确的 master key 文件。");
    }
    if (err instanceof CredentialDecryptError) {
      throw new Error("LLM credential cannot be decrypted with current master key. Re-save the credential in Settings or restore the original master key.");
    }
    throw err;
  }
  if (!cred) throw new Error("No LLM credentials configured");

  // Prepare workspace
  const hostWorkDir = join(config.dataDir, "report-workspaces", reportId);
  ensureWorkDir(hostWorkDir);

  const skillDir = join(hostWorkDir, "skill");
  mkdirSync(skillDir, { recursive: true });
  const reportsDir = join(hostWorkDir, "reports");
  mkdirSync(reportsDir, { recursive: true });
  const contextDir = join(hostWorkDir, "context");
  mkdirSync(contextDir, { recursive: true });
  const outDir = join(hostWorkDir, "out");
  mkdirSync(outDir, { recursive: true });

  // Download and extract skill zip
  const minio = getMinio();
  const skillZipPath = join(hostWorkDir, "skill.zip");
  await minio.fGetObject(config.minio.bucket, skill.minio_key, skillZipPath);
  execSync(`cd "${skillDir}" && unzip -o -q "${skillZipPath}"`, { timeout: 30_000, stdio: "pipe" });
  logger.info({ reportId, skillId, skillDir }, "Report skill extracted");

  // Generate report context JSON with findings data
  const task = await getTaskById(taskId);
  const db = getDb();
  const findingsMeta = await db<{
    finding_key: string; severity: string; vuln_type: string | null;
    primary_file: string | null; primary_line: number | null;
    yaml_minio_key: string;
  }[]>`
    SELECT finding_key, severity, vuln_type, primary_file, primary_line, yaml_minio_key
    FROM findings_meta WHERE task_id = ${taskId}
    ORDER BY severity_numeric DESC, finding_key
  `;

  // Read YAML details for each finding from MinIO
  const findingsDetail: Array<{
    finding_key: string; severity: string; vuln_type: string | null;
    primary_file: string | null; primary_line: number | null;
    title: string; description: string;
  }> = [];
  for (const f of findingsMeta) {
    let title = f.finding_key;
    let description = "";
    try {
      const minio = getMinio();
      const stream = await minio.getObject(config.minio.bucket, f.yaml_minio_key);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      const yamlText = Buffer.concat(chunks).toString("utf-8");
      const { load } = await import("js-yaml");
      const doc = load(yamlText) as Record<string, unknown>;
      title = (doc.title as string) ?? f.finding_key;
      description = (doc.description as string) ?? (doc.summary as string) ?? "";
    } catch { /* use defaults */ }
    findingsDetail.push({
      finding_key: f.finding_key,
      severity: f.severity,
      vuln_type: f.vuln_type,
      primary_file: f.primary_file,
      primary_line: f.primary_line,
      title,
      description,
    });
  }

  const context = {
    task_id: taskId,
    report_id: reportId,
    project_name: task?.project_name ?? "unknown",
    scan_completed_at: task?.completed_at?.toISOString() ?? null,
    finding_count: findingsDetail.length,
    findings_by_severity: {
      critical: findingsDetail.filter(f => f.severity === "critical").length,
      high: findingsDetail.filter(f => f.severity === "high").length,
      medium: findingsDetail.filter(f => f.severity === "medium").length,
      low: findingsDetail.filter(f => f.severity === "low").length,
      info: findingsDetail.filter(f => f.severity === "info").length,
    },
    findings: findingsDetail,
    skill_name: skill.name,
  };
  writeFileSync(join(contextDir, "report-context.json"), JSON.stringify(context, null, 2));
  logger.info({ reportId, findingCount: findingsDetail.length }, "Report context generated");

  // Container
  const containerName = `va-report-${reportId}`;
  try {
    const docker = getDocker();
    await docker.getContainer(containerName).remove({ force: true });
  } catch { /* doesn't exist */ }

  const env: Record<string, string> = {
    MODE: "report",
    TASK_ID: taskId,
    REPORT_ID: reportId,
    ...credentialToWorkerEnv(cred),
  };

  const container = await createWorkerContainer({
    taskId: reportId,
    taskType: "report",
    image: config.docker.workerImage,
    network: config.docker.network,
    hostWorkDir,
    cpuQuota: 100000,
    memoryBytes: 2 * 1024 * 1024 * 1024,
    env,
  });

  await container.start();

  // Start tailing YoungFlow events under parent taskId
  const { startTailing } = await import("../events/event-tail.js");
  const eventsDir = join(hostWorkDir, "out", ".youngflow", "logs");
  try { mkdirSync(eventsDir, { recursive: true }); } catch { /* ok */ }
  startTailing(taskId, [], [{ path: eventsDir, source: "report" }]);

  logger.info({ reportId, taskId, containerName }, "Report worker started (YoungFlow mode)");
  return container.id;
}

/**
 * Handle report worker container die event.
 * Reads manifest, uploads report files to MinIO, updates DB.
 */
export async function onReportContainerDie(
  reportId: string,
  exitCode: number | undefined,
): Promise<void> {
  const report = await getReport(reportId);
  if (!report) return;

  // If already completed (e.g. by legacy submit_report MCP), skip
  if (report.status === "completed") {
    logger.info({ reportId }, "Report already completed");
    return;
  }

  const config = (await import("../../infra/config.js")).loadConfig();
  const hostWorkDir = join(config.dataDir, "report-workspaces", reportId);
  const manifestPath = join(hostWorkDir, "out", "report-manifest.json");
  const reportsDir = join(hostWorkDir, "reports");

  if (exitCode === 0 && existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      const primaryFile = manifest.primary_file ?? "security-report.md";

      // Path traversal protection — reject dangerous file paths from LLM output
      const { resolve, relative } = await import("node:path");
      const resolvedPath = resolve(reportsDir, primaryFile);
      const rel = relative(reportsDir, resolvedPath);
      if (rel.startsWith("..") || resolve(reportsDir, rel) !== resolvedPath || !primaryFile || primaryFile.startsWith("/")) {
        throw new Error(`Unsafe file path in manifest: ${primaryFile}`);
      }
      const primaryPath = resolvedPath;

      if (!existsSync(primaryPath)) {
        throw new Error(`Primary report file not found: ${primaryFile}`);
      }

      // Upload to MinIO (same structure as submit-report MCP)
      const minio = getMinio();
      const bucket = config.minio.bucket;
      const fmt = manifest.format ?? "md";
      const primaryKey = `user-reports/${report.task_id}/${reportId}/primary.${fmt}`;
      await minio.fPutObject(bucket, primaryKey, primaryPath);

      // Create bundle tar
      execSync(`tar -cf "${join(hostWorkDir, "bundle.tar")}" -C "${reportsDir}" .`, { timeout: 30_000, stdio: "pipe" });
      const bundleKey = `user-reports/${report.task_id}/${reportId}/bundle.tar`;
      await minio.fPutObject(bucket, bundleKey, join(hostWorkDir, "bundle.tar"));

      // Update DB
      await updateReportStatus(reportId, "completed", {
        format: fmt,
        primaryMinioKey: primaryKey,
        bundleMinioKey: bundleKey,
      });

      logger.info({ reportId, primaryFile }, "Report completed via manifest");
    } catch (err) {
      logger.error({ err, reportId }, "Failed to process report manifest");
      await updateReportStatus(reportId, "failed", {
        failureReason: `Manifest processing failed: ${err}`,
      });
    }
  } else if (exitCode === 0) {
    // Exit 0 but no manifest — try to find report files directly
    try {
      const reportFiles = readdirSync(reportsDir).filter(f => f.endsWith(".md"));
      if (reportFiles.length > 0) {
        const primaryFile = reportFiles[0];
        const minio = getMinio();
        const bucket = config.minio.bucket;
        const primaryKey = `user-reports/${report.task_id}/${reportId}/primary.md`;
        await minio.fPutObject(bucket, primaryKey, join(reportsDir, primaryFile));

        execSync(`tar -cf "${join(hostWorkDir, "bundle.tar")}" -C "${reportsDir}" .`, { timeout: 30_000, stdio: "pipe" });
        const bundleKey = `user-reports/${report.task_id}/${reportId}/bundle.tar`;
        await minio.fPutObject(bucket, bundleKey, join(hostWorkDir, "bundle.tar"));

        await updateReportStatus(reportId, "completed", {
          format: "md",
          primaryMinioKey: primaryKey,
          bundleMinioKey: bundleKey,
        });
        logger.info({ reportId, primaryFile }, "Report completed (no manifest, found .md file)");
      } else {
        await updateReportStatus(reportId, "failed", {
          failureReason: "Worker exited without producing report files",
        });
      }
    } catch (err) {
      await updateReportStatus(reportId, "failed", {
        failureReason: `Report salvage failed: ${err}`,
      });
    }
  } else {
    await updateReportStatus(reportId, "failed", {
      failureReason: `Worker exited with code ${exitCode}`,
    });
  }

  notify({ type: "task_state", taskId: report.task_id, state: "completed" as never });
  logger.info({ reportId, exitCode }, "Report worker died");
}
