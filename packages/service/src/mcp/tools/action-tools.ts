/**
 * MCP Action Tools — P1 tools for Chat Agent platform operations.
 */
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, join, normalize, resolve } from "node:path";
import * as taskStorage from "../../features/tasks/storage.js";
import { cancelTask, continueTask, pauseTask, restartTask, resumeTask, TaskControlError } from "../../features/tasks/control-service.js";
import type { McpContext } from "../context.js";
import type { QueryContext } from "../../infra/query-context.js";
import { buildBufferPreview } from "../../features/chat/artifact-preview.js";


type ToolResult = { content: Array<{ type: "text"; text: string }> };

function text(t: string): ToolResult {
  return { content: [{ type: "text", text: t }] };
}

function toQueryContext(ctx: McpContext): QueryContext {
  return { tenantId: ctx.tenantId, userId: ctx.userId, role: ctx.role === "admin" ? "admin" : "member" };
}

// ─── control-task ───

export const controlTaskSchema = {
  task_id: z.string().describe("The task ID"),
  action: z.enum(["pause", "resume", "cancel", "restart", "continue"]).describe("操作类型：pause=暂停, resume=恢复, cancel=取消, restart=重新开始, continue=在已有结果基础上继续深入扫描"),
  audit_focus: z
    .string()
    .optional()
    .describe("仅 continue 时可选：调整审计关注面（自然语言）。"),
  scan_duration: z
    .number()
    .optional()
    .describe("仅 continue 时可选：调整扫描时长（分钟）。"),
};

export async function controlTask(args: { task_id: string; action: string; audit_focus?: string; scan_duration?: number }, _ctx?: McpContext): Promise<ToolResult> {
  const task = _ctx ? await taskStorage.getTaskById(toQueryContext(_ctx), args.task_id) : await taskStorage.getTaskById(args.task_id);
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
      case "continue": {
        const focus = typeof args.audit_focus === "string" ? args.audit_focus.trim() : undefined;
        const scanTimeout =
          typeof args.scan_duration === "number" && Number.isFinite(args.scan_duration) && args.scan_duration > 0
            ? Math.trunc(args.scan_duration) * 60
            : undefined;
        const result = await continueTask(task.id, { auditFocus: focus, scanTimeout });
        return text(`Task ${result.task.project_name} queued to continue scanning on top of existing results.`);
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
  const task = await taskStorage.getTaskById(toQueryContext(ctx), args.task_id);
  if (!task) return text("Task not found.");

  try {
    const { assertNoActiveOperation } = await import("../../features/tasks/operation-lock.js");
    await assertNoActiveOperation(task.id, "report");
  } catch (err: any) {
    if (err.code === "ERR_TASK_BUSY") return text(`Task is busy: ${err.message}`);
    throw err;
  }

  // skill_id optional: omit → builtin default template; if set must be owned
  const reportStorage = await import("../../features/reports/storage.js");
  let skillId: string | null = args.skill_id?.trim() || null;
  if (skillId) {
    const owned = await reportStorage.getOwnedSkill(skillId, ctx.userId);
    if (!owned) return text("skill_id must refer to a skill you own.");
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

  // Always emit a report_ref card so the UI shows artifact panel (VULNHUN-159),
  // not just a markdown file path the user cannot open.
  const refJson = JSON.stringify(
    {
      type: "report_ref",
      task_id: task.id,
      report_id: report.id,
      title: skillId ? `Report · ${skillId}` : "Report · builtin",
      summary: `generating · ${findingKeys.length} findings`,
    },
    null,
    2,
  );

  return text(
    [
      `Report generation started.`,
      `- **Report ID**: ${report.id}`,
      `- **Task**: ${task.project_name}`,
      `- **Skill**: ${skillId ?? "builtin default"}`,
      `- **Findings**: ${findingKeys.length} selected`,
      ``,
      `A report card is attached below — open it from the artifact panel when ready.`,
      ``,
      "```json",
      refJson,
      "```",
    ].join("\n"),
  );
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
}, ctx: McpContext): Promise<ToolResult> {
  if (ctx.actorType !== "chat" || !ctx.sessionId) {
    return text("Error: present-artifact is only available in Chat sessions.");
  }
  if (!args.content && !args.source_path) {
    return text("Error: Either content or source_path is required.");
  }

  const config = (await import("../../infra/config.js")).loadConfig();
  const safeFilename = basename(args.filename || "artifact.txt").replace(/[^a-zA-Z0-9._-]/g, "_") || "artifact.txt";
  const mimeType = args.mime_type ?? "text/plain";
  let buffer: Buffer;
  let workspacePath: string | null = null;

  if (args.source_path) {
    const normalized = normalize(args.source_path);
    if (!normalized.startsWith("/workspace/")) {
      return text("Error: source_path must be within /workspace/.");
    }
    const relative = normalized.replace(/^\/workspace\//, "");
    if (!relative || relative.startsWith("..") || relative.includes("/../")) {
      return text("Error: Path traversal is not allowed.");
    }
    const sessionRoot = resolve(config.dataDir, "chat-sessions", ctx.sessionId);
    const hostPath = resolve(join(sessionRoot, relative));
    if (!hostPath.startsWith(`${sessionRoot}/`) && hostPath !== sessionRoot) {
      return text("Error: source_path resolves outside the chat session workspace.");
    }
    buffer = await readFile(hostPath);
    workspacePath = normalized;
  } else {
    buffer = Buffer.from(args.content ?? "", "utf8");
  }

  const artifactId = randomUUID();
  const minioKey = `chat-artifacts/${ctx.sessionId}/presented/${artifactId}/${safeFilename}`;
  const { getMinio } = await import("../../infra/minio/client.js");
  await getMinio().putObject(config.minio.bucket, minioKey, buffer);

  const { getDb } = await import("../../infra/db/client.js");
  const db = getDb();
  const preview = buildBufferPreview(buffer, mimeType);
  await db`
    INSERT INTO chat_artifacts (id, tenant_id, session_id, user_id, kind, title, original_name, filename, mime_type, size_bytes, minio_key, workspace_path, metadata)
    VALUES (${artifactId}, ${ctx.tenantId}, ${ctx.sessionId}, ${ctx.userId}, 'presented', ${args.title}, ${args.filename}, ${safeFilename}, ${mimeType}, ${buffer.length}, ${minioKey}, ${workspacePath}, ${JSON.stringify({ source_path: args.source_path ?? null, preview: preview.preview ?? null, preview_status: preview.preview_status, preview_truncated: preview.preview_truncated, preview_limit_bytes: 64 * 1024 })}::jsonb)
  `;

  const { notify } = await import("../../features/notifications/index.js");
  notify({ type: "chat_artifact_created", sessionId: ctx.sessionId, artifactId, ownerId: ctx.userId });

  return text(JSON.stringify({
    type: "chat_artifact",
    artifact_id: artifactId,
    title: args.title,
    filename: safeFilename,
    mime_type: mimeType,
    size_bytes: buffer.length,
    preview: preview.preview,
    preview_status: preview.preview_status,
    preview_truncated: preview.preview_truncated,
    download_url: `/api/chat/sessions/${ctx.sessionId}/artifacts/${artifactId}/download`,
  }, null, 2));
}

