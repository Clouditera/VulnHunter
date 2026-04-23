/**
 * MCP tool implementations for the VulnHunt platform.
 * These tools allow Chat agents to query platform data.
 */

import { z } from "zod";
import { load as yamlLoad } from "js-yaml";
import { execSync } from "node:child_process";
import { join } from "node:path";
import * as findingsStorage from "../features/findings/storage.js";
import * as taskStorage from "../features/tasks/storage.js";
import * as reportStorage from "../features/reports/storage.js";
import { getMinio, uploadFile } from "../infra/minio/client.js";
import { loadConfig } from "../infra/config.js";
import { notify } from "../features/notifications/index.js";
import { logger } from "../infra/logger.js";

type ToolResult = { content: Array<{ type: "text"; text: string }> };

// ─── list-findings ───

export const listFindingsSchema = {
  task_id: z.string().describe("The task ID to list findings for"),
  severity: z.enum(["high", "medium", "low", "info"]).optional().describe("Filter by severity"),
  limit: z.number().optional().default(20).describe("Max results (default 20)"),
};

export async function listFindings(args: {
  task_id: string;
  severity?: "high" | "medium" | "low" | "info";
  limit?: number;
}): Promise<ToolResult> {
  logger.debug({ args }, "MCP list-findings");

  const findings = await findingsStorage.listFindings({
    taskId: args.task_id,
    severity: args.severity,
    limit: args.limit ?? 20,
  });

  if (findings.length === 0) {
    return {
      content: [{ type: "text", text: `No findings found for task ${args.task_id}${args.severity ? ` with severity ${args.severity}` : ""}.` }],
    };
  }

  const lines = findings.map((f) =>
    `- **${f.finding_key}** [${f.severity.toUpperCase()}] ${f.vuln_type ?? "unknown"} — ${f.primary_file ?? "?"}:${f.primary_line ?? "?"}${f.function_name ? ` (${f.function_name})` : ""}`,
  );

  const summary = `Found ${findings.length} finding(s) for task ${args.task_id}:\n\n${lines.join("\n")}`;
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
}): Promise<ToolResult> {
  logger.debug({ args }, "MCP read-finding");

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

  if (detail.description) sections.push(`\n### Description\n${detail.description}`);
  if (detail.remediation) sections.push(`\n### Remediation\n${detail.remediation}`);
  if (detail.data_flow) sections.push(`\n### Data Flow\n${formatValue(detail.data_flow)}`);
  if (detail.taint_path) sections.push(`\n### Taint Path\n${formatValue(detail.taint_path)}`);
  if (detail.attack) sections.push(`\n### Attack Scenario\n${formatValue(detail.attack)}`);
  if (detail.code_diff) sections.push(`\n### Code Diff\n\`\`\`\n${detail.code_diff}\n\`\`\``);
  if (detail.references) sections.push(`\n### References\n${formatValue(detail.references)}`);

  return sections.join("\n");
}

function formatValue(val: unknown): string {
  if (typeof val === "string") return val;
  if (Array.isArray(val)) return val.map((v, i) => `${i + 1}. ${typeof v === "string" ? v : JSON.stringify(v)}`).join("\n");
  return JSON.stringify(val, null, 2);
}

// ─── read-task-metadata ───

export const readTaskMetadataSchema = {
  task_id: z.string().describe("The task ID to read metadata for"),
};

export async function readTaskMetadata(args: {
  task_id: string;
}): Promise<ToolResult> {
  logger.debug({ args }, "MCP read-task-metadata");

  const task = await taskStorage.getTaskById(args.task_id);
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
  state: z.enum(["queued", "running", "paused", "completed", "failed", "cancelled"]).optional().describe("Filter by state"),
  limit: z.number().optional().default(10).describe("Max results (default 10)"),
};

export async function listTasks(args: {
  state?: string;
  limit?: number;
}): Promise<ToolResult> {
  logger.debug({ args }, "MCP list-tasks");

  const tasks = await taskStorage.listTasks({
    state: args.state as never,
    limit: args.limit ?? 10,
  });

  if (tasks.length === 0) {
    return {
      content: [{ type: "text", text: `No tasks found${args.state ? ` with state ${args.state}` : ""}.` }],
    };
  }

  const header = `Found ${tasks.length} task(s):\n\n| project | id | state | created |\n|---|---|---|---|`;
  const rows = tasks.map((t) =>
    `| ${t.project_name} | ${t.id} | ${t.state} | ${new Date(t.created_at).toLocaleDateString()} |`,
  );

  return {
    content: [{ type: "text", text: `${header}\n${rows.join("\n")}\n\nUse the full \`id\` column value for subsequent tool calls (e.g. list-findings, read-task-metadata, cancel-task).` }],
  };
}

// ─── cancel-task ───

export const cancelTaskSchema = {
  task_id: z.string().describe("The task ID to cancel"),
};

export async function cancelTask(args: {
  task_id: string;
}): Promise<ToolResult> {
  logger.debug({ args }, "MCP cancel-task");

  const task = await taskStorage.getTaskById(args.task_id);
  if (!task) {
    return { content: [{ type: "text", text: `Task ${args.task_id} not found.` }] };
  }

  if (!["running", "paused", "queued"].includes(task.state)) {
    return {
      content: [{ type: "text", text: `Task ${task.project_name} is in state '${task.state}' and cannot be cancelled.` }],
    };
  }

  await taskStorage.updateTaskState(task.id, "cancelled", { completedAt: new Date() });
  return {
    content: [{ type: "text", text: `Task ${task.project_name} (${task.id}) has been cancelled.` }],
  };
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
