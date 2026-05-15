/**
 * MCP Action Tools — P1 tools for Chat Agent platform operations.
 */
import { z } from "zod";
import * as taskStorage from "../../features/tasks/storage.js";
import { cancelTask, pauseTask, restartTask, resumeTask, TaskControlError } from "../../features/tasks/control-service.js";
import type { McpContext } from "../context.js";


type ToolResult = { content: Array<{ type: "text"; text: string }> };

function text(t: string): ToolResult {
  return { content: [{ type: "text", text: t }] };
}

// ─── control-task ───

export const controlTaskSchema = {
  task_id: z.string().describe("The task ID"),
  action: z.enum(["pause", "resume", "cancel", "restart"]).describe("Action to perform"),
};

export async function controlTask(args: { task_id: string; action: string }, _ctx?: McpContext): Promise<ToolResult> {
  const task = await taskStorage.getTaskById(args.task_id);
  if (!task) return text("Task not found.");

  try {
    switch (args.action) {
      case "cancel": {
        const result = await cancelTask(task.id);
        return text(`Task ${result.task.project_name} cancelled.`);
      }
      case "pause": {
        const result = await pauseTask(task.id);
        return text(`Task ${result.task.project_name} paused.`);
      }
      case "restart": {
        const result = await restartTask(task.id);
        return text(`Task ${result.task.project_name} queued for restart.`);
      }
      case "resume": {
        const result = await resumeTask(task.id);
        return text(`Task ${result.task.project_name} queued for resume.`);
      }
      default:
        return text(`Unknown action: ${args.action}`);
    }
  } catch (err: any) {
    if (err instanceof TaskControlError) return text(err.message);
    throw err;
  }
}

// ─── generate-report ───

export const generateReportSchema = {
  task_id: z.string().describe("The task ID to generate report for"),
  skill_id: z.string().optional().describe("Report skill ID (uses default if omitted)"),
  finding_keys: z.array(z.string()).optional().describe("Finding keys to include (defaults to pending+confirmed)"),
};

export async function generateReport(args: { task_id: string; skill_id?: string; finding_keys?: string[] }, ctx: McpContext): Promise<ToolResult> {
  const task = await taskStorage.getTaskById(args.task_id);
  if (!task) return text("Task not found.");

  try {
    const { assertNoActiveOperation } = await import("../../features/tasks/operation-lock.js");
    await assertNoActiveOperation(task.id, "report");
  } catch (err: any) {
    if (err.code === "ERR_TASK_BUSY") return text(`Task is busy: ${err.message}`);
    throw err;
  }

  // Get skill
  const reportStorage = await import("../../features/reports/storage.js");
  let skillId = args.skill_id;
  if (!skillId) {
    const skills = await reportStorage.listSkills();
    if (skills.length === 0) return text("No report skills configured.");
    skillId = skills[0].id;
  }

  // Get finding keys
  let findingKeys = args.finding_keys;
  if (!findingKeys || findingKeys.length === 0) {
    const { listFindings } = await import("../../features/findings/storage.js");
    const findings = await listFindings({ taskId: task.id, reviewStatuses: ["pending", "confirmed"], limit: 1000 });
    findingKeys = findings.map((f) => f.finding_key);
  }

  const report = await reportStorage.createReport({
    taskId: task.id,
    skillId,
    createdBy: ctx.userId,
  });

  // Spawn report worker
  const { spawnReportWorker } = await import("../../features/reports/report-worker.js");
  const config = (await import("../../infra/config.js")).loadConfig();
  await spawnReportWorker({ taskId: task.id, reportId: report.id, skillId, createdBy: ctx.userId, config });

  return text([
    `Report generation started.`,
    `- **Report ID**: ${report.id}`,
    `- **Task**: ${task.project_name}`,
    `- **Findings**: ${findingKeys.length} selected`,
    ``,
    `Use \`get-task-detail\` to check report status.`,
  ].join("\n"));
}

// ─── generate-poc ───

export const generatePocSchema = {
  task_id: z.string().describe("The task ID"),
  finding_keys: z.array(z.string()).describe("Finding keys to generate POC for"),
  target_url: z.string().describe("Target application URL"),
  custom_instructions: z.string().optional().describe("Custom instructions for POC generation"),
};

export async function generatePoc(args: {
  task_id: string;
  finding_keys: string[];
  target_url: string;
  custom_instructions?: string;
}, ctx: McpContext): Promise<ToolResult> {
  const task = await taskStorage.getTaskById(args.task_id);
  if (!task) return text("Task not found.");
  if (!args.finding_keys.length) return text("No finding keys provided.");

  try {
    const { assertNoActiveOperation } = await import("../../features/tasks/operation-lock.js");
    await assertNoActiveOperation(task.id, "poc");
  } catch (err: any) {
    if (err.code === "ERR_TASK_BUSY") return text(`Task is busy: ${err.message}`);
    throw err;
  }

  const pocStorage = await import("../../features/poc/storage.js");
  const job = await pocStorage.createPocJob({
    taskId: task.id,
    targetMode: "provided",
    targetUrl: args.target_url,
    customInstructions: args.custom_instructions,
    browserTool: "none",
    findingKeys: args.finding_keys,
    createdBy: ctx.userId,
  });

  return text([
    `POC generation started.`,
    `- **Job ID**: ${job.id}`,
    `- **Task**: ${task.project_name}`,
    `- **Target**: ${args.target_url}`,
    `- **Findings**: ${args.finding_keys.length}`,
    ``,
    `Use \`get-task-detail\` to check POC status.`,
  ].join("\n"));
}

// ─── present-artifact ───

export const presentArtifactSchema = {
  title: z.string().describe("Display title for the artifact"),
  filename: z.string().describe("Filename for download"),
  content: z.string().optional().describe("File content (text/markdown/html). Use this OR source_path."),
  source_path: z.string().optional().describe("Path within /workspace to present. Use this OR content."),
  mime_type: z.string().optional().default("text/plain").describe("MIME type"),
};

export async function presentArtifact(args: {
  title: string;
  filename: string;
  content?: string;
  source_path?: string;
  mime_type?: string;
}): Promise<ToolResult> {
  if (!args.content && !args.source_path) {
    return text("Error: Either content or source_path is required.");
  }

  // Validate source_path: must be within /workspace and not contain traversal
  if (args.source_path) {
    const { resolve, normalize } = await import("node:path");
    const normalized = normalize(args.source_path);
    // Reject absolute paths outside /workspace and any path traversal
    if (!normalized.startsWith("/workspace/") && !normalized.startsWith("/workspace")) {
      return text("Error: source_path must be within /workspace/.");
    }
    if (normalized.includes("..")) {
      return text("Error: Path traversal (..) is not allowed.");
    }
    // Resolve and re-check
    const resolved = resolve("/workspace", normalized.replace(/^\/workspace\/?/, ""));
    if (!resolved.startsWith("/workspace")) {
      return text("Error: source_path resolves outside /workspace.");
    }
  }

  if (args.content) {
    return text([
      `📎 **${args.title}**`,
      `_${args.filename}_ (${args.mime_type ?? "text/plain"})`,
      "",
      "---",
      args.content,
    ].join("\n"));
  }

  return text([
    `📎 **${args.title}**`,
    `_${args.filename}_ at ${args.source_path}`,
    ``,
    `File prepared at workspace path. Use the \`read\` tool to view its contents.`,
  ].join("\n"));
}
