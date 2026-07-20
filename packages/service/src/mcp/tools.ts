/**
 * MCP tool implementations for the VulnAgent platform.
 * These tools allow Chat agents to query platform data.
 */

import { z } from "zod";
import { load as yamlLoad } from "js-yaml";
import { execSync } from "node:child_process";
import { join } from "node:path";
import * as findingsStorage from "../features/findings/storage.js";
import * as taskStorage from "../features/tasks/storage.js";
import { cancelTask as cancelTaskControl, TaskControlError } from "../features/tasks/control-service.js";
import * as reportStorage from "../features/reports/storage.js";
import { getMinio, uploadFile } from "../infra/minio/client.js";
import { loadConfig } from "../infra/config.js";
import { notify } from "../features/notifications/index.js";
import { scanMetaFromValues } from "../features/files/routes.js";
import { logger } from "../infra/logger.js";
import type { McpContext } from "./context.js";
import type { QueryContext } from "../infra/query-context.js";

type ToolResult = { content: Array<{ type: "text"; text: string }> };

function toQueryContext(ctx: McpContext): QueryContext {
  return { tenantId: ctx.tenantId, userId: ctx.userId, role: ctx.role === "admin" ? "admin" : "member" };
}

// ─── list-findings ───

export const listFindingsSchema = {
  task_id: z.string().describe("The task ID to list findings for"),
  item_type: z
    .enum(["finding", "risk", "all"])
    .optional()
    .describe("查询类型：finding=漏洞（已确认可利用）, risk=风险（存在隐患）, all=全部。默认 finding。"),
  severity: z.enum(["high", "medium", "low", "info"]).optional().describe("Filter by severity"),
  limit: z.number().optional().default(20).describe("Max results (default 20)"),
};

export async function listFindings(args: {
  task_id: string;
  item_type?: "finding" | "risk" | "all";
  severity?: "high" | "medium" | "low" | "info";
  limit?: number;
}, ctx?: McpContext): Promise<ToolResult> {
  logger.debug({ args }, "MCP list-findings");
  if (ctx) {
    const task = await taskStorage.getTaskById(toQueryContext(ctx), args.task_id);
    if (!task) return { content: [{ type: "text", text: `Task ${args.task_id} not found.` }] };
  }

  const itemType = args.item_type ?? "finding";
  const findings = await findingsStorage.listFindings({
    taskId: args.task_id,
    itemType,
    severity: args.severity,
    limit: args.limit ?? 20,
  });

  const label = itemType === "risk" ? "risk" : itemType === "all" ? "finding/risk" : "finding";
  if (findings.length === 0) {
    return {
      content: [{ type: "text", text: `No ${label} items found for task ${args.task_id}${args.severity ? ` with severity ${args.severity}` : ""}.` }],
    };
  }

  const lines = findings.map((f) =>
    `- **${f.finding_key}** [${f.severity.toUpperCase()}] ${f.vuln_type ?? "unknown"} — ${f.primary_file ?? "?"}:${f.primary_line ?? "?"}${f.function_name ? ` (${f.function_name})` : ""}`,
  );

  const summary = `Found ${findings.length} ${label} item(s) for task ${args.task_id}:\n\n${lines.join("\n")}`;
  return { content: [{ type: "text", text: summary }] };
}

// ─── read-finding ───

export const readFindingSchema = {
  task_id: z.string().describe("The task ID"),
  finding_key: z.string().describe("The finding key (e.g. BUG-001)"),
};

export async function readFinding(args: {
  task_id: string;
  finding_key: string;
}, ctx?: McpContext): Promise<ToolResult> {
  logger.debug({ args }, "MCP read-finding");
  if (ctx) {
    const task = await taskStorage.getTaskById(toQueryContext(ctx), args.task_id);
    if (!task) return { content: [{ type: "text", text: `Task ${args.task_id} not found.` }] };
  }

  const meta = await findingsStorage.getFindingByKey(args.task_id, args.finding_key);
  if (!meta) {
    return {
      content: [{ type: "text", text: `Finding ${args.finding_key} not found in task ${args.task_id}.` }],
    };
  }

  // Fetch YAML detail from MinIO
  const config = loadConfig();
  try {
    const minio = getMinio();
    const stream = await minio.getObject(config.minio.bucket, meta.yaml_minio_key);
    const raw = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      stream.on("error", reject);
    });

    const detail = yamlLoad(raw) as Record<string, unknown>;
    const text = formatFindingDetail(meta, detail);
    return { content: [{ type: "text", text }] };
  } catch (err) {
    // Fallback to metadata only
    return {
      content: [{ type: "text", text: formatFindingMeta(meta) }],
    };
  }
}

function formatFindingMeta(meta: findingsStorage.DbFindingMeta): string {
  return [
    `## ${meta.finding_key} [${meta.severity.toUpperCase()}]`,
    `- **Type**: ${meta.vuln_type ?? "unknown"}${meta.cwe ? ` (${meta.cwe})` : ""}`,
    `- **File**: ${meta.primary_file ?? "?"}:${meta.primary_line ?? "?"}`,
    meta.function_name ? `- **Function**: ${meta.function_name}` : null,
    meta.language ? `- **Language**: ${meta.language}` : null,
  ].filter(Boolean).join("\n");
}

function formatFindingDetail(
  meta: findingsStorage.DbFindingMeta,
  detail: Record<string, unknown>,
): string {
  const sections: string[] = [
    `## ${meta.finding_key} [${meta.severity.toUpperCase()}]`,
    `**Type**: ${meta.vuln_type ?? "unknown"}${meta.cwe ? ` (${meta.cwe})` : ""}`,
    `**File**: ${meta.primary_file ?? "?"}:${meta.primary_line ?? "?"}`,
  ];

  // Handle both canonical schema (metadata/description/code/data_flow/attack/remediation)
  // and older schema variants
  const desc = detail.description as Record<string, unknown> | string | undefined;
  const code = detail.code as Record<string, unknown> | undefined;
  const dataFlow = detail.data_flow as Record<string, unknown> | undefined;
  const attack = detail.attack as Record<string, unknown> | undefined;
  const remediation = detail.remediation as Record<string, unknown> | string | undefined;
  const refs = detail.references as unknown[] | undefined;

  if (desc) sections.push(`\n### Description\n${formatValue(desc)}`);
  if (code) sections.push(`\n### Code\n${formatValue(code)}`);
  if (dataFlow) sections.push(`\n### Data Flow\n${formatValue(dataFlow)}`);
  if (attack) sections.push(`\n### Attack Scenario\n${formatValue(attack)}`);
  if (remediation) sections.push(`\n### Remediation\n${formatValue(remediation)}`);
  if (refs) sections.push(`\n### References\n${formatValue(refs)}`);

  return sections.join("\n");
}

function formatValue(val: unknown): string {
  if (typeof val === "string") return val;
  if (typeof val === "number" || typeof val === "boolean") return String(val);
  if (Array.isArray(val)) {
    return val.map((v, i) => {
      if (typeof v === "string") return `${i + 1}. ${v}`;
      if (typeof v === "object" && v !== null) return `${i + 1}. ${formatObject(v as Record<string, unknown>)}`;
      return `${i + 1}. ${String(v)}`;
    }).join("\n");
  }
  if (typeof val === "object" && val !== null) return formatObject(val as Record<string, unknown>);
  return String(val);
}

function formatObject(obj: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string") {
      lines.push(`**${k}**: ${v}`);
    } else if (typeof v === "number" || typeof v === "boolean") {
      lines.push(`**${k}**: ${v}`);
    } else if (Array.isArray(v)) {
      lines.push(`**${k}**:`);
      lines.push(formatValue(v));
    } else if (typeof v === "object") {
      lines.push(`**${k}**:`);
      lines.push(formatObject(v as Record<string, unknown>));
    }
  }
  return lines.join("\n");
}

// ─── read-task-metadata ───

export const readTaskMetadataSchema = {
  task_id: z.string().describe("The task ID to read metadata for"),
};

export async function readTaskMetadata(args: {
  task_id: string;
}, ctx?: McpContext): Promise<ToolResult> {
  logger.debug({ args }, "MCP read-task-metadata");

  const task = ctx ? await taskStorage.getTaskById(toQueryContext(ctx), args.task_id) : await taskStorage.getTaskById(args.task_id);
  if (!task) {
    return {
      content: [{ type: "text", text: `Task ${args.task_id} not found.` }],
    };
  }

  // Get finding counts
  const counts = await findingsStorage.countFindingsBySeverity(args.task_id);

  const meta = task.metadata as Record<string, unknown> ?? {};
  const sections: string[] = [
    `## Task: ${task.project_name}`,
    `- **ID**: ${task.id}`,
    `- **State**: ${task.state}`,
    `- **Source**: ${task.source_type}`,
    `- **Created**: ${task.created_at}`,
    task.started_at ? `- **Started**: ${task.started_at}` : null,
    task.completed_at ? `- **Completed**: ${task.completed_at}` : null,
    task.duration_ms ? `- **Duration**: ${(task.duration_ms / 1000).toFixed(1)}s` : null,
    task.failure_reason ? `- **Failure**: ${task.failure_reason}` : null,
    "",
    `### Findings Summary`,
    `- High: ${counts.high}`,
    `- Medium: ${counts.medium}`,
    `- Low: ${counts.low}`,
    `- Info: ${counts.info}`,
  ].filter((s) => s !== null);

  // Add profiler metadata if available
  if (meta.language) sections.push(`\n### Project Profile`, `- **Language**: ${meta.language}`);
  if (meta.total_files) sections.push(`- **Files**: ${meta.total_files}`);
  if (meta.total_loc) sections.push(`- **LOC**: ${meta.total_loc}`);
  if (meta.description) sections.push(`- **Description**: ${meta.description}`);
  if (meta.model_name) sections.push(`\n### Execution`, `- **Model**: ${meta.model_name}`);
  if (meta.total_stages) sections.push(`- **Stages**: ${meta.total_stages}`);

  return { content: [{ type: "text", text: sections.join("\n") }] };
}

// ─── list-tasks ───

export const listTasksSchema = {
  state: z.enum(["queued", "preparing", "running", "paused", "completed", "failed", "cancelled"]).optional().describe("Filter by state"),
  limit: z.number().optional().default(10).describe("Max results (default 10)"),
};

export async function listTasks(args: {
  state?: string;
  limit?: number;
}, ctx?: McpContext): Promise<ToolResult> {
  logger.debug({ args }, "MCP list-tasks");

  const tasks = ctx ? await taskStorage.listTasks(toQueryContext(ctx), {
    state: args.state as never,
    limit: args.limit ?? 10,
  }) : await taskStorage.listTasks({
    state: args.state as never,
    limit: args.limit ?? 10,
  });

  if (tasks.length === 0) {
    return {
      content: [{ type: "text", text: `No tasks found${args.state ? ` with state ${args.state}` : ""}.` }],
    };
  }

  const header = `共 ${tasks.length} 个任务：\n\n| 任务名称 | 任务 ID | 状态 | 创建时间 |\n|---|---|---|---|`;
  const rows = tasks.map((t) =>
    `| ${t.project_name} | ${t.id} | ${t.state} | ${new Date(t.created_at).toLocaleDateString()} |`,
  );

  return {
    content: [{ type: "text", text: `${header}\n${rows.join("\n")}\n\n（后续操作调用工具时使用完整的任务 ID。）` }],
  };
}

async function resolveTaskCredential(ctx: McpContext) {
  const { getDefaultCredential, getCredentialById } = await import("../features/settings/storage.js");
  const queryCtx = toQueryContext(ctx);
  if (ctx.actorType === "chat" && ctx.credentialId) return getCredentialById(queryCtx, ctx.credentialId);
  return getDefaultCredential(queryCtx);
}

// ─── cancel-task ───

export const cancelTaskSchema = {
  task_id: z.string().describe("The task ID to cancel"),
};

export async function cancelTask(args: {
  task_id: string;
}, _ctx?: McpContext): Promise<ToolResult> {
  logger.debug({ args }, "MCP cancel-task");

  const task = _ctx ? await taskStorage.getTaskById(toQueryContext(_ctx), args.task_id) : await taskStorage.getTaskById(args.task_id);
  if (!task) return { content: [{ type: "text", text: "Task not found." }] };
  try {
    const result = await cancelTaskControl(task.id);
    return {
      content: [{ type: "text", text: `任务「${result.task.project_name}」已取消，任务 ID \`${result.task.id}\`，当前状态：已取消（cancelled）。` }],
    };
  } catch (err) {
    if (err instanceof TaskControlError) {
      return { content: [{ type: "text", text: err.message }] };
    }
    throw err;
  }
}

// ─── submit-report ───

export const submitReportSchema = {
  task_id: z.string().describe("The task ID this report belongs to"),
  report_id: z.string().describe("The report ID (from the generate API)"),
  name: z.string().describe("Report file name (e.g. 'security-audit-report.md')"),
  format: z.enum(["md", "html", "json", "pdf", "txt"]).describe("Report format"),
  primary_file: z.string().describe("Path to the primary report file relative to /workspace/reports/"),
};

export async function submitReport(args: {
  task_id: string;
  report_id: string;
  name: string;
  format: string;
  primary_file: string;
}): Promise<ToolResult> {
  logger.info({ args }, "MCP submit-report");

  const report = await reportStorage.getReport(args.report_id);
  if (!report) {
    return { content: [{ type: "text", text: `Report ${args.report_id} not found.` }] };
  }

  if (report.status === "completed") {
    return { content: [{ type: "text", text: `Report already submitted.` }] };
  }

  const config = loadConfig();
  const bucket = config.minio.bucket;
  const reportDir = join(config.dataDir, "report-workspaces", args.report_id, "reports");

  try {
    // Upload primary file
    const primaryKey = `user-reports/${args.task_id}/${args.report_id}/primary.${args.format}`;
    const primaryPath = join(reportDir, args.primary_file);
    const { readFileSync } = await import("node:fs");
    const primaryContent = readFileSync(primaryPath);
    await uploadFile(bucket, primaryKey, primaryContent, primaryContent.length);

    // Tar the entire reports directory → upload as bundle
    const bundleKey = `user-reports/${args.task_id}/${args.report_id}/bundle.tar`;
    const tarPath = join(config.dataDir, "report-workspaces", args.report_id, "bundle.tar");
    execSync(`tar -cf "${tarPath}" -C "${reportDir}" .`, { timeout: 30_000, stdio: "pipe" });
    const tarContent = readFileSync(tarPath);
    await uploadFile(bucket, bundleKey, tarContent, tarContent.length);

    // Update DB
    await reportStorage.updateReportStatus(args.report_id, "completed", {
      format: args.format,
      primaryMinioKey: primaryKey,
      bundleMinioKey: bundleKey,
    });

    // Notify frontend
    notify({ type: "task_state", taskId: args.task_id, state: "completed" as never });

    return {
      content: [{ type: "text", text: `Report submitted successfully. Format: ${args.format}, file: ${args.name}` }],
    };
  } catch (err) {
    logger.error({ err, reportId: args.report_id }, "Failed to submit report");
    return {
      content: [{ type: "text", text: `Failed to submit report: ${err}` }],
    };
  }
}

// ─── create-task ───

export const createTaskSchema = {
  project_name: z.string().optional().describe("Detected project/source name; optional"),
  display_name: z.string().optional().describe("Optional user-facing task display name"),
  git_url: z.string().optional().describe("Git repository URL (use this OR attachment_id). Must be an http(s) URL."),
  git_branch: z.string().optional().describe("Git branch. If omitted, the remote default branch is used."),
  attachment_id: z.string().optional().describe("Chat artifact ID of an uploaded zip file (use this OR git_url)"),
  audit_focus: z
    .string()
    .optional()
    .describe("用户关注的安全审计方向，直接使用用户原话。"),
  scan_duration: z
    .number()
    .optional()
    .describe("扫描时长（分钟），仅 timeout_mode=custom 时有效：默认 600（10 小时），范围 30–4320。auto 模式无需提供。"),
  timeout_mode: z
    .enum(["custom", "auto"])
    .optional()
    .describe("扫描时长模式：custom=自定义主动结束时长（默认 10 小时）；auto=由任务自由判断调度（最多 72 小时）。默认 custom。"),
  enable_dynamic_verify: z
    .boolean()
    .optional()
    .describe("动态验证/漏洞利用评估（EXP）——大幅提升漏洞准确率，但显著延长任务时间。用户只说“扫一下”时默认不开。"),
  enable_dynamic_exploit: z
    .boolean()
    .optional()
    .describe("漏洞利用（组合链）——需先开启动态验证/漏洞利用评估（EXP）（enable_dynamic_verify）。"),
};

export async function createMcpTask(args: {
  project_name?: string;
  display_name?: string;
  git_url?: string;
  git_branch?: string;
  attachment_id?: string;
  audit_focus?: string;
  scan_duration?: number;
  timeout_mode?: "custom" | "auto";
  enable_dynamic_verify?: boolean;
  enable_dynamic_exploit?: boolean;
}, ctx: McpContext): Promise<ToolResult> {
  const config = loadConfig();

  if (!args.git_url && !args.attachment_id) {
    return { content: [{ type: "text", text: "Error: Either git_url or attachment_id is required." }] };
  }

  // VulnForge scan params, built via the exact same scanMetaFromValues the web
  // form channel uses — guaranteeing byte-equivalent source_meta across the two
  // channels (the chat↔form equivalence acceptance criterion). scan_duration is
  // minutes (user-facing); dynamic toggles map through shared dynamic-toggles.ts.
  let scanMeta: Record<string, string | number | boolean>;
  try {
    scanMeta = scanMetaFromValues(
      args.audit_focus,
      typeof args.scan_duration === "number" && Number.isFinite(args.scan_duration) && args.scan_duration > 0
        ? Math.trunc(args.scan_duration) * 60
        : undefined,
      undefined,
      args.timeout_mode ?? undefined,
      {
        enableDynamicVerify: args.enable_dynamic_verify,
        enableDynamicExploit: args.enable_dynamic_exploit,
      },
    );
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
  }

  const cred = await resolveTaskCredential(ctx);
  if (!cred) {
    return { content: [{ type: "text", text: "Error: 当前会话没有可用模型凭证。请在右上角选择模型或在 Settings 配置默认凭证后重试。" }] };
  }

  if (args.attachment_id) {
    if (ctx.actorType !== "chat" || !ctx.sessionId) {
      return { content: [{ type: "text", text: "Error: attachment_id can only be used from a Chat session." }] };
    }
    // Attachment-based task creation. Authorization is based on server-side McpContext,
    // not values supplied by the agent.
    const db = (await import("../infra/db/client.js")).getDb();
    const [artifact] = await db<{ id: string; original_name: string; minio_key: string; size_bytes: number; session_id: string; user_id: string; tenant_id: string }[]>`
      SELECT id, original_name, minio_key, size_bytes, session_id, user_id, tenant_id FROM chat_artifacts
      WHERE id = ${args.attachment_id}
        AND kind = 'upload'
        AND session_id = ${ctx.sessionId}
        AND user_id = ${ctx.userId}
        AND tenant_id = ${ctx.tenantId}
      LIMIT 1
    `;
    if (!artifact) {
      return { content: [{ type: "text", text: "Error: Attachment not found or not accessible in this Chat session." }] };
    }

    const projectName = args.project_name ?? artifact.original_name.replace(/\.(zip|tar\.gz|tgz)$/i, "");

    const task = await taskStorage.createTask({
      createdBy: ctx.userId,
      projectName,
      displayName: args.display_name,
      sourceType: "upload",
      sourceMeta: { filename: artifact.original_name, minio_key: artifact.minio_key, size_bytes: artifact.size_bytes, chat_artifact_id: artifact.id, ...scanMeta },
      credentialId: cred.id,
    });

    // Copy artifact from chat-artifacts to code-packages
    const minio = getMinio();
    const targetKey = `code-packages/${task.id}.zip`;
    await minio.copyObject(config.minio.bucket, targetKey, `/${config.minio.bucket}/${artifact.minio_key}`);

    // Update task with code package key
    await db`UPDATE tasks SET source_meta = COALESCE(source_meta, '{}'::jsonb) || ${db.json({ code_package_key: targetKey })}::jsonb WHERE id = ${task.id}`;

    notify({ type: "task_state", taskId: task.id, state: "queued" });

    return {
      content: [{
        type: "text",
        text: [
          `任务「${projectName}」已创建成功，任务 ID \`${task.id}\`，当前状态：排队中（queued）。`,
          `来源：${artifact.original_name}（${Math.round(artifact.size_bytes / 1024)}KB），凭证：${cred.label ?? "default"}。就绪后自动开始扫描。`,
        ].join("\n"),
      }],
    };
  }

  // Git-based task creation
  const { cloneAndUpload } = await import("../features/files/git-clone.js");
  const { GitRemoteError, validateRemoteGitUrl } = await import("../features/files/git-remote.js");
  let safeGitUrl: string;
  try {
    safeGitUrl = validateRemoteGitUrl(args.git_url!);
  } catch (err) {
    const detail = err instanceof GitRemoteError ? err.message : "Invalid git URL";
    return { content: [{ type: "text", text: `Error: ${detail}. 请提供合法的 http(s) Git 仓库地址。` }] };
  }
  const requestedBranch = args.git_branch?.trim() || undefined;
  const projectName = args.project_name ??
    new URL(safeGitUrl).pathname.split("/").pop()?.replace(/\.git$/, "") ?? "project";

  const task = await taskStorage.createTask({
    createdBy: ctx.userId,
    projectName,
    displayName: args.display_name,
    sourceType: "git",
    sourceMeta: { git_url: safeGitUrl, ...(requestedBranch ? { git_branch: requestedBranch } : {}), ...scanMeta },
    credentialId: cred.id,
  });

  // Git task starts in `preparing` (cloning) — distinct from `queued`.
  await taskStorage.updateTaskState(task.id, "preparing");
  cloneAndUpload(
    task.id,
    safeGitUrl,
    requestedBranch,
    config.minio.bucket,
  ).catch((err) => logger.error({ err, taskId: task.id }, "MCP create-task: git clone failed"));

  notify({ type: "task_state", taskId: task.id, state: "preparing" });

  return {
    content: [{
      type: "text",
      text: [
        `任务「${projectName}」已创建成功，任务 ID \`${task.id}\`，当前状态：准备中（preparing）。`,
        `来源：${safeGitUrl}${requestedBranch ? `（分支：${requestedBranch}）` : "（分支：远程默认）"}，凭证：${cred.label ?? "default"}。代码克隆在后台进行，就绪后自动开始扫描。`,
      ].join("\n"),
    }],
  };
}
