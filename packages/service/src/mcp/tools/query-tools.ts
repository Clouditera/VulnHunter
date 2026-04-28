/**
 * MCP Query Tools — P0 tools for Chat Agent platform data access.
 */
import { z } from "zod";
import * as taskStorage from "../../features/tasks/storage.js";
import * as findingsStorage from "../../features/findings/storage.js";
import { getDashboard } from "../../features/dashboard/service.js";
import { logger } from "../../infra/logger.js";

type ToolResult = { content: Array<{ type: "text"; text: string }> };

function text(t: string): ToolResult {
  return { content: [{ type: "text", text: t }] };
}

// ─── get-platform-overview ───

export const getPlatformOverviewSchema = {};

export async function getPlatformOverview(): Promise<ToolResult> {
  const dashboard = await getDashboard("all");
  const lines = [
    "# Platform Overview",
    "",
    `- Total scans: ${dashboard.stats.total_scans.value}`,
    `- Total vulnerabilities: ${dashboard.stats.vulnerabilities.value}`,
    `- Avg scan duration: ${dashboard.stats.avg_duration_min.value} min`,
    "",
    "## Severity Distribution",
    `- High: ${dashboard.severity_dist.high}`,
    `- Medium: ${dashboard.severity_dist.medium}`,
    `- Low: ${dashboard.severity_dist.low}`,
    `- Info: ${dashboard.severity_dist.info}`,
    "",
    "## Review Progress",
    `- Pending: ${dashboard.review_status_dist.pending}`,
    `- Confirmed: ${dashboard.review_status_dist.confirmed}`,
    `- False Positive: ${dashboard.review_status_dist.false_positive}`,
    `- Ignored: ${dashboard.review_status_dist.ignored}`,
    "",
    "## Recent Scans",
    ...dashboard.recent_scans.slice(0, 5).map((s) =>
      `- ${s.project_name} (${s.state}) — H:${s.severity_counts.h} M:${s.severity_counts.m} L:${s.severity_counts.l}`,
    ),
  ];
  return text(lines.join("\n"));
}

// ─── get-task-detail ───

export const getTaskDetailSchema = {
  task_id: z.string().describe("The task ID to get details for"),
};

export async function getTaskDetail(args: { task_id: string }): Promise<ToolResult> {
  const task = await taskStorage.getTaskById(args.task_id);
  if (!task) return text("Task not found.");

  const sevCounts = await findingsStorage.countFindingsBySeverity(args.task_id);
  const reviewCounts = await findingsStorage.countFindingsByReviewStatus(args.task_id);

  const lines = [
    `# Task: ${task.project_name}`,
    "",
    `- ID: ${task.id}`,
    `- State: ${task.state}`,
    `- Source: ${task.source_type} (${task.source_meta?.git_url || task.source_meta?.filename || "—"})`,
    `- Created: ${task.created_at}`,
    task.started_at ? `- Started: ${task.started_at}` : null,
    task.completed_at ? `- Completed: ${task.completed_at}` : null,
    task.duration_ms ? `- Duration: ${Math.round(task.duration_ms / 60000)} min` : null,
    task.failure_reason ? `- Failure: ${task.failure_reason}` : null,
    "",
    "## Findings",
    `- Total: ${sevCounts.high + sevCounts.medium + sevCounts.low + sevCounts.info}`,
    `- High: ${sevCounts.high}, Medium: ${sevCounts.medium}, Low: ${sevCounts.low}, Info: ${sevCounts.info}`,
    "",
    "## Review Status",
    `- Pending: ${reviewCounts.pending}, Confirmed: ${reviewCounts.confirmed}`,
    `- False Positive: ${reviewCounts.false_positive}, Ignored: ${reviewCounts.ignored}`,
  ].filter(Boolean);

  return text(lines.join("\n"));
}

// ─── get-task-events ───

export const getTaskEventsSchema = {
  task_id: z.string().describe("The task ID"),
  source: z.enum(["scan", "report", "poc", "all"]).optional().default("all").describe("Event source filter"),
  limit: z.number().optional().default(30).describe("Max events to return"),
};

export async function getTaskEvents(args: { task_id: string; source?: string; limit?: number }): Promise<ToolResult> {
  try {
    const task = await taskStorage.getTaskById(args.task_id);
    if (!task) return text("Task not found.");

    const { loadTaskEvents } = await import("../../features/events/event-archive.js");
    const limit = Math.min(args.limit ?? 30, 100);
    const events = await loadTaskEvents({
      taskId: args.task_id,
      taskState: task.state,
      source: args.source,
      limit,
    });

    if (events.length === 0) {
      return text("No events found for this task.");
    }

    const lines = events.map((e: any) => {
      const ev = e.event || e;
      const ts = ev.ts || ev.timestamp || "";
      const type = ev.event || ev.type || "unknown";
      const msg = ev.message || ev.msg || ev.stage || "";
      return `[${ts}] ${type}: ${msg}`;
    });

    return text(`# Task Events (showing ${events.length})\n\n${lines.join("\n")}`);
  } catch (err) {
    logger.warn({ err, taskId: args.task_id }, "Failed to load task events for MCP");
    return text("Unable to load events for this task.");
  }
}
