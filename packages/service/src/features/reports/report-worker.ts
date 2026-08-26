/**
 * Report Worker — spawns YoungFlow report flow in container.
 *
 * Service generates context JSON with findings data, injects uploaded
 * Report Skill, runs YoungFlow. On completion, reads manifest and
 * uploads report files to MinIO.
 */

import { displayedScanDurationMs } from "@vulnhunter/shared";
import { dirname, join } from "node:path";
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, rmSync, openSync, closeSync, fstatSync, readSync } from "node:fs";
import { execSync } from "node:child_process";
import {
  createWorkerContainer,
  ensureWorkDir,
  getDocker,
} from "../workers/docker-client.js";
import { getDefaultCredential, getCredentialById } from "../settings/storage.js";
import { CredentialDecryptError, CredentialKeyUnavailableError } from "../../infra/crypto/master-key-vault.js";
import { credentialToWorkerEnv, writeWorkerModelsJson } from "../settings/credential-env.js";
import { getSkill, updateReportStatus, getReport } from "./storage.js";
import { getMinio } from "../../infra/minio/client.js";
import { notify } from "../notifications/index.js";
import { logger } from "../../infra/logger.js";
import { getTaskById, type DbTask } from "../tasks/storage.js";
import { mergeTaskMetadata } from "../tasks/storage.js";
import { countFindingsBySeverity, countFindingsByItemType } from "../findings/storage.js";
import { getDb } from "../../infra/db/client.js";
import type { ServiceConfig } from "../../infra/config.js";
import { resolveArchiveIdentity } from "../source-archives/detect.js";
import { extractSourceArchive, prepareSourceArchiveDestination } from "../source-archives/extract.js";
import type { SourceArchiveWarning } from "../source-archives/errors.js";
import { buildSourceArchivePolicy, getSourceArchivePolicy, type SourceArchivePolicy } from "../source-archives/policy.js";

interface MaterializedReportContext {
  findingCount: number;
  riskCount: number;
  wikiPages: number;
  sourceAvailable: boolean;
}

const FAILURE_LOG_TAIL_BYTES = 64 * 1024;
const FAILURE_DETAIL_MAX_LENGTH = 300;

function readFileTail(path: string): string {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, FAILURE_LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function sanitizeFailureDetail(detail: string): string {
  return detail
    .replace(
      /\b(api[_-]?key|authorization|token|secret|password)\b(["']?\s*[=:]\s*["']?)[^\s",;}]+/gi,
      "$1$2[REDACTED]",
    )
    .replace(/\bBearer\s+[^\s,;}]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "sk-[REDACTED]")
    .trim()
    .slice(0, FAILURE_DETAIL_MAX_LENGTH);
}

function findLastErrorLine(raw: string): string {
  const lines = raw.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (/error|fatal|\b[45]\d\d\b/i.test(lines[index])) return sanitizeFailureDetail(lines[index]);
  }
  return "";
}

export function buildReportFailureReason(exitCode: number | undefined, errorDetail: string): string {
  return errorDetail
    ? `报告生成失败（退出码 ${exitCode}）：${errorDetail}`
    : `Worker exited with code ${exitCode}`;
}

export async function readReportFailureDetail(hostWorkDir: string, reportId: string): Promise<string> {
  const logPath = join(hostWorkDir, "out", ".youngflow", "logs", "youngflow.service.jsonl");
  try {
    const detail = findLastErrorLine(readFileTail(logPath));
    if (detail) return detail;
  } catch { /* evidence collection must not mask the worker failure */ }

  try {
    const container = getDocker().getContainer(`va-report-${reportId}`);
    const output = await container.logs({ stdout: true, stderr: true, tail: 50 });
    return findLastErrorLine(output.toString("utf8"));
  } catch {
    return "";
  }
}

export function safeContextFilename(name: string, fallback = "item"): string {
  const safe = name
    .trim()
    .replace(/[\\/\r\n\t\0]/g, "_")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^\.+$/, fallback);
  return safe || fallback;
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer | string>) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function listMinioKeys(bucket: string, prefix: string): Promise<string[]> {
  const minio = getMinio();
  return new Promise((resolve, reject) => {
    const keys: string[] = [];
    const stream = minio.listObjects(bucket, prefix, true);
    stream.on("data", (obj) => { if (obj.name) keys.push(obj.name); });
    stream.on("end", () => resolve(keys));
    stream.on("error", reject);
  });
}

export async function extractArchiveToSource(archivePath: string, filename: string, sourceDir: string, policy: SourceArchivePolicy = buildSourceArchivePolicy({})): Promise<{ warnings: SourceArchiveWarning[] }> {
  prepareSourceArchiveDestination(sourceDir);
  return extractSourceArchive(archivePath, filename, sourceDir, policy);
}
async function materializeSourceArchive(params: {
  task: DbTask;
  hostWorkDir: string;
  config: ServiceConfig;
}): Promise<{ available: boolean; filename?: string; minioKey?: string; path?: string; error?: string }> {
  const { task, hostWorkDir, config } = params;
  const archive = resolveArchiveIdentity({ taskId: task.id, sourceMeta: task.source_meta });
  const minioKey = archive.minioKey;
  const filename = archive.filename;
  const sourceDir = join(hostWorkDir, "source");
  const archivePath = join(hostWorkDir, "source-archive");

  try {
    await getMinio().fGetObject(config.minio.bucket, minioKey, archivePath);
    const { warnings = [] } = await extractArchiveToSource(archivePath, filename, sourceDir, await getSourceArchivePolicy());
    // HALL-19: keep dropped-link warnings visible on the task record + logs.
    if (warnings.length > 0) {
      logger.warn({ taskId: task.id, warnings }, "Source archive symlinks dropped during report extraction");
      await mergeTaskMetadata(task.id, { source_archive_warnings: warnings }).catch((err) =>
        logger.warn({ err, taskId: task.id }, "Failed to persist source archive warnings"),
      );
    }
    return { available: true, filename, minioKey, path: "/workspace/source" };
  } catch (err) {
    logger.warn({ err, taskId: task.id, minioKey }, "Failed to materialize source archive for report context");
    rmSync(sourceDir, { recursive: true, force: true });
    return { available: false, filename, minioKey, error: String(err) };
  }
}

async function materializeReportContext(params: {
  task: DbTask;
  reportId: string;
  skillName: string;
  hostWorkDir: string;
  contextDir: string;
  config: ServiceConfig;
}): Promise<MaterializedReportContext> {
  const { task, reportId, skillName, hostWorkDir, contextDir, config } = params;
  const db = getDb();
  const bucket = config.minio.bucket;
  const findingsDir = join(contextDir, "findings");
  const wikiDir = join(contextDir, "wiki");
  const reviewedDir = join(contextDir, "reviewed");
  mkdirSync(findingsDir, { recursive: true });
  mkdirSync(wikiDir, { recursive: true });
  mkdirSync(reviewedDir, { recursive: true });

  const findingsMeta = await db<Array<{
    finding_key: string;
    severity: string;
    vuln_type: string | null;
    vuln_type_full: string | null;
    cwe: string | null;
    cvss_vector: string | null;
    cvss_score: number | null;
    primary_file: string | null;
    primary_line: number | null;
    function_name: string | null;
    item_type: "finding" | "risk";
    review_status: string;
    yaml_minio_key: string;
  }>>`
    SELECT finding_key, severity, vuln_type, vuln_type_full, cwe, cvss_vector, cvss_score,
           primary_file, primary_line, function_name, item_type, review_status, yaml_minio_key
    FROM findings_meta
    WHERE task_id = ${task.id}
    ORDER BY severity_numeric DESC, finding_key
  `;

  const { load } = await import("js-yaml");
  const findingIndex: Array<Record<string, unknown>> = [];
  for (const f of findingsMeta) {
    const filename = `${safeContextFilename(f.finding_key)}.yaml`;
    const targetPath = join(findingsDir, filename);
    let title = f.finding_key;
    let raw = "";
    try {
      raw = (await streamToBuffer(await getMinio().getObject(bucket, f.yaml_minio_key))).toString("utf-8");
      writeFileSync(targetPath, raw);
      const doc = load(raw) as Record<string, unknown> | null;
      title = typeof doc?.title === "string" && doc.title.trim() ? doc.title : f.finding_key;
    } catch (err) {
      logger.warn({ err, taskId: task.id, findingKey: f.finding_key, minioKey: f.yaml_minio_key }, "Failed to materialize finding YAML");
      writeFileSync(targetPath, `# YAML unavailable for ${f.finding_key}\n`);
    }
    findingIndex.push({
      finding_key: f.finding_key,
      item_type: f.item_type,
      severity: f.severity,
      title,
      vuln_type: f.vuln_type,
      vuln_type_full: f.vuln_type_full,
      cwe: f.cwe,
      cvss_vector: f.cvss_vector,
      cvss_score: f.cvss_score,
      primary_file: f.primary_file,
      primary_line: f.primary_line,
      function_name: f.function_name,
      review_status: f.review_status,
      yaml_path: `/workspace/context/findings/${filename}`,
    });
  }
  writeFileSync(join(findingsDir, "index.json"), JSON.stringify(findingIndex, null, 2));

  let wikiPages = 0;
  try {
    const wiki = await import("../wiki/routes.js");
    const isRunning = task.state === "running" || task.state === "paused";
    const pageNames = await wiki.listWikiPageNames(task, config);
    for (const pageName of pageNames) {
      const content = await wiki.readWikiPageContent(task, config, pageName, isRunning);
      if (content !== null) {
        writeFileSync(join(wikiDir, safeContextFilename(pageName, "wiki.md")), content);
        wikiPages += 1;
      }
    }
    for (const relPath of wiki.PROFILER_ARTIFACT_PATHS) {
      const raw = await wiki.readArtifact(task.id, config, relPath, isRunning);
      if (raw !== null) {
        writeFileSync(join(contextDir, "profiler.yaml"), raw);
        break;
      }
    }
  } catch (err) {
    logger.warn({ err, taskId: task.id }, "Failed to materialize wiki/profiler context");
  }

  try {
    const reviewedPrefix = `scan-outputs/${task.id}/reviewed/`;
    const reviewedKeys = await listMinioKeys(bucket, reviewedPrefix);
    for (const key of reviewedKeys) {
      const rel = key.slice(reviewedPrefix.length).split("/").map((p) => safeContextFilename(p)).join("/");
      const targetPath = join(reviewedDir, rel);
      mkdirSync(dirname(targetPath), { recursive: true });
      await getMinio().fGetObject(bucket, key, targetPath);
    }
    writeFileSync(join(reviewedDir, "index.json"), JSON.stringify(reviewedKeys.map((key) => ({
      minio_key: key,
      path: `/workspace/context/reviewed/${key.slice(reviewedPrefix.length).split("/").map((p) => safeContextFilename(p)).join("/")}`,
    })), null, 2));
  } catch (err) {
    logger.warn({ err, taskId: task.id }, "Failed to materialize reviewed artifacts");
  }

  const severityCounts = await countFindingsBySeverity(task.id, "all");
  const itemCounts = await countFindingsByItemType(task.id);
  const taskMetadata = {
    task_id: task.id,
    report_id: reportId,
    project_name: task.project_name,
    display_name: task.display_name,
    state: task.state,
    source_type: task.source_type,
    source_meta: task.source_meta,
    created_at: task.created_at,
    started_at: task.started_at,
    completed_at: task.completed_at,
    duration_ms: displayedScanDurationMs(task),
    total_duration_ms: task.total_duration_ms,
    run_count: task.run_count,
    risk_score: task.risk_score,
    failure_reason: task.failure_reason,
    findings_indexed_at: task.findings_indexed_at,
    metadata: task.metadata,
    token_usage: {
      input_tokens: task.input_tokens,
      output_tokens: task.output_tokens,
      cache_read_tokens: task.cache_read_tokens,
      cache_write_tokens: task.cache_write_tokens,
      total_tokens: task.total_tokens,
      total_tokens_in: task.total_tokens_in,
      total_tokens_out: task.total_tokens_out,
      tool_call_count: task.tool_call_count,
      stage_count: task.stage_count,
    },
    counts: {
      severity: severityCounts,
      item_type: itemCounts,
      total_items: findingIndex.length,
    },
  };
  writeFileSync(join(contextDir, "task-metadata.json"), JSON.stringify(taskMetadata, null, 2));

  const source = await materializeSourceArchive({ task, hostWorkDir, config });
  const contextIndex = {
    schema_version: 2,
    task_id: task.id,
    report_id: reportId,
    project_name: task.project_name,
    skill_name: skillName,
    generated_at: new Date().toISOString(),
    data_contract: "rich-file-materialization",
    instructions: [
      "This file is an entry index, not the full data payload.",
      "Enumerate every item in /workspace/context/findings/index.json; it includes both findings and risks and is not truncated.",
      "Read each /workspace/context/findings/<finding_key>.yaml for full CWE/CVSS/code/data_flow/attack/remediation/anchors/reviewed details.",
      "Use /workspace/context/task-metadata.json for project configuration and execution summary.",
      "Use /workspace/context/wiki/*.md and /workspace/context/profiler.yaml for project knowledge/profile.",
      "Use /workspace/context/reviewed/ for reviewed artifacts when present.",
      "Use /workspace/source as the read-only source tree for file:line verification and code snippets when present.",
    ],
    paths: {
      task_metadata: "/workspace/context/task-metadata.json",
      findings_index: "/workspace/context/findings/index.json",
      findings_dir: "/workspace/context/findings",
      wiki_dir: "/workspace/context/wiki",
      profiler: existsSync(join(contextDir, "profiler.yaml")) ? "/workspace/context/profiler.yaml" : null,
      reviewed_dir: "/workspace/context/reviewed",
      source_dir: source.available ? "/workspace/source" : null,
    },
    counts: {
      findings: findingIndex.filter((f) => f.item_type === "finding").length,
      risks: findingIndex.filter((f) => f.item_type === "risk").length,
      total_items: findingIndex.length,
      wiki_pages: wikiPages,
    },
    source,
  };
  writeFileSync(join(contextDir, "report-context.json"), JSON.stringify(contextIndex, null, 2));

  return {
    findingCount: contextIndex.counts.findings,
    riskCount: contextIndex.counts.risks,
    wikiPages,
    sourceAvailable: source.available,
  };
}

export async function spawnReportWorker(params: {
  taskId: string;
  reportId: string;
  /** null/undefined → builtin default-report-skill (report-mode.sh fallback) */
  skillId?: string | null;
  credentialId?: string;
  createdBy: string;
  config: ServiceConfig;
}): Promise<string> {
  const { taskId, reportId, skillId, config } = params;

  let skillName = "内置模板";
  let skill: Awaited<ReturnType<typeof getSkill>> = null;
  if (skillId) {
    skill = await getSkill(skillId);
    if (!skill) throw new Error("Skill not found");
    skillName = skill.name;
  }

  // Load task once for both credential resolution and context materialization
  const task = await getTaskById(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);

  let cred;
  try {
    // Credential resolution: 3-level fallback (architect 2026-08-12)
    // 1. Explicit credentialId (from API request)
    // 2. Task's credential_id (report should use the same credential as the scan)
    // 3. getDefaultCredential() (legacy fallback for tasks without a credential)
    // Boundary: task.credential_id set but credential deleted → explicit error, no silent fallback
    if (params.credentialId) {
      cred = await getCredentialById(params.credentialId);
      if (!cred) throw new Error(`Specified credential not found: ${params.credentialId}`);
    } else if (task.credential_id) {
      cred = await getCredentialById(task.credential_id);
      if (!cred) throw new Error(`任务关联的凭证已删除 (credential_id: ${task.credential_id})。请重新设置任务凭证或在报告参数中显式指定凭证。`);
    } else {
      cred = await getDefaultCredential();
    }
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

  // Download and extract user skill zip when provided; otherwise leave skill/
  // empty so report-mode.sh copies default-report-skill.
  if (skill) {
    const minio = getMinio();
    const skillZipPath = join(hostWorkDir, "skill.zip");
    await minio.fGetObject(config.minio.bucket, skill.minio_key, skillZipPath);
    execSync(`cd "${skillDir}" && unzip -o -q "${skillZipPath}"`, { timeout: 30_000, stdio: "pipe" });
    logger.info({ reportId, skillId, skillDir }, "Report skill extracted");
  } else {
    logger.info({ reportId }, "No skill_id — worker will use builtin default-report-skill");
  }

  // Materialize full report context as files. The YoungFlow report runtime is
  // file-based (not MCP-based), so report-context.json is only an entry index;
  // rich data lives under /workspace/context/*.
  // task already loaded above for credential resolution.
  const materializedContext = await materializeReportContext({
    task,
    reportId,
    skillName,
    hostWorkDir,
    contextDir,
    config,
  });
  logger.info(
    {
      reportId,
      taskId,
      findingCount: materializedContext.findingCount,
      riskCount: materializedContext.riskCount,
      wikiPages: materializedContext.wikiPages,
      sourceMounted: materializedContext.sourceAvailable,
    },
    "Rich report context materialized",
  );

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

  // Batch 2 (fish 2026-08-08): pre-generate models.json via the unified module.
  await writeWorkerModelsJson(cred, hostWorkDir);

  const container = await createWorkerContainer({
    taskId: reportId,
    taskType: "report",
    image: config.docker.workerImage,
    network: config.docker.network,
    hostWorkDir,
    cpuQuota: 100000,
    memoryBytes: 2 * 1024 * 1024 * 1024,
    env,
    extraMounts: materializedContext.sourceAvailable
      ? [{ Type: "bind", Source: join(hostWorkDir, "source"), Target: "/workspace/source", ReadOnly: true }]
      : undefined,
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
        // Exit 0 but no report files — read youngflow log for real error (fish 2026-08-12)
        const detail = await readReportFailureDetail(hostWorkDir, reportId);
        await updateReportStatus(reportId, "failed", {
          failureReason: detail
            ? buildReportFailureReason(exitCode, detail)
            : "Worker exited without producing report files",
        });
      }
    } catch (err) {
      await updateReportStatus(reportId, "failed", {
        failureReason: `Report salvage failed: ${err}`,
      });
    }
  } else {
    const errorDetail = await readReportFailureDetail(hostWorkDir, reportId);
    await updateReportStatus(reportId, "failed", {
      failureReason: buildReportFailureReason(exitCode, errorDetail),
    });
  }

  notify({ type: "task_state", taskId: report.task_id, state: "completed" as never });
  logger.info({ reportId, exitCode }, "Report worker died");
}
