/**
 * MCP Action Tools — P1 tools for Chat Agent platform operations.
 */
import { z } from "zod";
import * as taskStorage from "../../features/tasks/storage.js";
import { notify } from "../../features/notifications/index.js";


type ToolResult = { content: Array<{ type: "text"; text: string }> };

function text(t: string): ToolResult {
  return { content: [{ type: "text", text: t }] };
}

// ─── control-task ───

export const controlTaskSchema = {
  task_id: z.string().describe("The task ID"),
  action: z.enum(["pause", "resume", "cancel", "restart"]).describe("Action to perform"),
};

export async function controlTask(args: { task_id: string; action: string }): Promise<ToolResult> {
  const task = await taskStorage.getTaskById(args.task_id);
  if (!task) return text("Task not found.");

  try {
    const { assertNoActiveOperation } = await import("../../features/tasks/operation-lock.js");

    switch (args.action) {
      case "cancel": {
        if (!["running", "paused", "queued"].includes(task.state)) {
          return text(`Cannot cancel task in '${task.state}' state.`);
        }
        await assertNoActiveOperation(task.id, "scan");
        await taskStorage.updateTaskState(task.id, "cancelled" as any);
        notify({ type: "task_state", taskId: task.id, state: "cancelled" });
        return text(`Task ${task.project_name} cancelled. Container will be stopped by scheduler.`);
      }
      case "pause": {
        if (task.state !== "running") return text(`Cannot pause task in '${task.state}' state.`);
        await taskStorage.updateTaskState(task.id, "paused" as any);
        notify({ type: "task_state", taskId: task.id, state: "paused" });
        return text(`Task ${task.project_name} paused.`);
      }
      case "restart": {
        if (!["failed", "cancelled", "completed"].includes(task.state)) {
          return text(`Cannot restart task in '${task.state}' state.`);
        }
        await taskStorage.updateTaskState(task.id, "queued" as any);
        notify({ type: "task_state", taskId: task.id, state: "queued" });
        return text(`Task ${task.project_name} queued for restart.`);
      }
      case "resume": {
        if (task.state !== "paused") return text(`Cannot resume task in '${task.state}' state.`);
        await taskStorage.updateTaskState(task.id, "queued" as any);
        notify({ type: "task_state", taskId: task.id, state: "queued" });
        return text(`Task ${task.project_name} queued for resume.`);
      }
      default:
        return text(`Unknown action: ${args.action}`);
    }
  } catch (err: any) {
    if (err.code === "ERR_TASK_BUSY") return text(`Task is busy: ${err.message}`);
    throw err;
  }
}

// ─── generate-report ───

export const generateReportSchema = {
  task_id: z.string().describe("The task ID to generate report for"),
  skill_id: z.string().optional().describe("Report skill ID (uses default if omitted)"),
  finding_keys: z.array(z.string()).optional().describe("Finding keys to include (defaults to pending+confirmed)"),
};

export async function generateReport(args: { task_id: string; skill_id?: string; finding_keys?: string[] }): Promise<ToolResult> {
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
    createdBy: task.created_by ?? "mcp",
  });

  // Spawn report worker
  const { spawnReportWorker } = await import("../../features/reports/report-worker.js");
  const config = (await import("../../infra/config.js")).loadConfig();
  await spawnReportWorker({ taskId: task.id, reportId: report.id, skillId, createdBy: task.created_by ?? "mcp", config });

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
}): Promise<ToolResult> {
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
    createdBy: task.created_by ?? "mcp",
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

  // For now, return the content/info as formatted text
  // Full artifact upload to MinIO + DB will be done when we have session context in tool calls
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
