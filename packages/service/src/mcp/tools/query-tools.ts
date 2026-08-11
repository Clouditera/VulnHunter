/**
 * MCP Query Tools — P0 tools for Chat Agent platform data access.
 */
import { displayedScanDurationMs } from "@vulnhunter/shared";
import { z } from "zod";
import * as taskStorage from "../../features/tasks/storage.js";
import * as findingsStorage from "../../features/findings/storage.js";
import { getDashboard } from "../../features/dashboard/service.js";
import { logger } from "../../infra/logger.js";
import type { McpContext } from "../context.js";
import type { QueryContext } from "../../infra/query-context.js";

type ToolResult = { content: Array<{ type: "text"; text: string }> };

function text(t: string): ToolResult {
  return { content: [{ type: "text", text: t }] };
}

function toQueryContext(ctx: McpContext): QueryContext {
  return { tenantId: ctx.tenantId, userId: ctx.userId, role: ctx.role === "admin" ? "admin" : "member" };
}

// ─── get-platform-overview ───

export const getPlatformOverviewSchema = {};

export async function getPlatformOverview(ctx: McpContext): Promise<ToolResult> {
  const dashboard = await getDashboard(toQueryContext(ctx), "all");
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
    ...dashboard.recent_scans
      .slice(0, 5)
      .map(
        (s) =>
          `- ${s.project_name} (${s.state}) — H:${s.severity_counts.h} M:${s.severity_counts.m} L:${s.severity_counts.l}`,
      ),
  ];
  return text(lines.join("\n"));
}

// ─── get-task-detail ───

export const getTaskDetailSchema = {
  task_id: z.string().describe("The task ID to get details for"),
};

export async function getTaskDetail(args: { task_id: string }, ctx: McpContext): Promise<ToolResult> {
  const task = await taskStorage.getTaskById(toQueryContext(ctx), args.task_id);
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
    (() => {
      const duration = displayedScanDurationMs(task);
      return duration ? `- Duration: ${Math.round(duration / 60000)} min` : null;
    })(),
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
  source: z
    .enum(["scan", "report", "poc", "all"])
    .optional()
    .default("all")
    .describe("Event source filter"),
  limit: z.number().optional().default(30).describe("Max events to return"),
};

export async function getTaskEvents(args: {
  task_id: string;
  source?: string;
  limit?: number;
}, ctx: McpContext): Promise<ToolResult> {
  try {
    const task = await taskStorage.getTaskById(toQueryContext(ctx), args.task_id);
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

// ─── read-wiki (P1) ───

export const readWikiSchema = {
  task_id: z.string().describe("The task ID"),
  page: z
    .string()
    .optional()
    .describe("Wiki page filename, e.g. overview.md. Omit to read the index/listing."),
};

export async function readWiki(args: { task_id: string; page?: string }, ctx: McpContext): Promise<ToolResult> {
  try {
    const task = await taskStorage.getTaskById(toQueryContext(ctx), args.task_id);
    if (!task) return text("Task not found.");
    const config = (await import("../../infra/config.js")).loadConfig();
    const wiki = await import("../../features/wiki/routes.js");
    const isRunning = task.state === "running" || task.state === "paused";

    // VulnForge wiki: knowledge/wiki/*.md. Read the requested page, or list
    // available pages + index.md when no page is specified.
    const pages = await wiki.listWikiPageNames(task, config);
    if (pages.length > 0) {
      const pageName = args.page && pages.includes(args.page) ? args.page : (pages.includes("index.md") ? "index.md" : pages[0]);
      const content = await wiki.readWikiPageContent(task, config, pageName, isRunning);
      if (content) {
        const listing = pages.join(", ");
        return text(`# Wiki: ${pageName}\n\nAvailable pages: ${listing}\n\n${content}`);
      }
    }

    // Fallback: legacy/VulnForge profiler.yaml (project profile only).
    const profiler =
      (await wiki.readArtifact(task.id, config, "profiler.yaml", isRunning)) ??
      (await wiki.readArtifact(task.id, config, "profiler/project-profiler.yaml", isRunning));
    if (profiler) return text(`# Project Profile\n\n${profiler}`);

    return text("No wiki data available for this task.");
  } catch (err) {
    logger.warn({ err }, "Failed to load wiki for MCP");
    return text("Unable to load wiki data.");
  }
}

// ─── read-report (P1) ───

export const readReportSchema = {
  task_id: z.string().describe("The task ID"),
  report_id: z.string().optional().describe("Specific report ID (defaults to latest)"),
};

export async function readReport(args: {
  task_id: string;
  report_id?: string;
}, ctx: McpContext): Promise<ToolResult> {
  const task = await taskStorage.getTaskById(toQueryContext(ctx), args.task_id);
  if (!task) return text("Task not found.");
  const reportStorage = await import("../../features/reports/storage.js");
  const reports = await reportStorage.listReports(args.task_id);

  if (reports.length === 0) return text("No reports found for this task.");

  const report = args.report_id
    ? reports.find((r) => r.id === args.report_id)
    : (reports.find((r) => r.status === "completed") ?? reports[0]);

  if (!report) return text("Report not found.");

  if (report.status !== "completed") {
    return text(`Report ${report.id} is ${report.status}. ${report.failure_reason ?? ""}`);
  }

  if (!report.primary_minio_key) return text("Report has no content file.");

  try {
    const config = (await import("../../infra/config.js")).loadConfig();
    const minio = (await import("../../infra/minio/client.js")).getMinio();
    const stream = await minio.getObject(config.minio.bucket, report.primary_minio_key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const content = Buffer.concat(chunks).toString("utf-8");

    // Truncate if too long for MCP response
    if (content.length > 50000) {
      return text(
        `# Report (truncated, ${Math.round(content.length / 1024)}KB total)\n\n${content.slice(0, 50000)}\n\n... (truncated)`,
      );
    }
    return text(content);
  } catch (err) {
    logger.warn({ err }, "Failed to load report content");
    return text("Unable to load report content.");
  }
}

// ─── emit-reference (Phase 2) ───

export const emitReferenceSchema = {
  ref_type: z
    .enum(["task_ref", "finding_ref", "wiki_ref", "report_ref"])
    .describe("Reference type"),
  task_id: z.string().describe("Task ID"),
  finding_key: z.string().optional().describe("Finding key (for finding_ref)"),
  report_id: z.string().optional().describe("Report ID (for report_ref)"),
  section: z.string().optional().describe("Wiki section"),
  title: z.string().optional().describe("Display title override"),
  summary: z.string().optional().describe("One-line summary"),
};

export async function emitReference(args: {
  ref_type: "task_ref" | "finding_ref" | "wiki_ref" | "report_ref";
  task_id: string;
  finding_key?: string;
  report_id?: string;
  section?: string;
  title?: string;
  summary?: string;
}, ctx: McpContext): Promise<ToolResult> {
  const task = await taskStorage.getTaskById(toQueryContext(ctx), args.task_id);
  if (!task) return text("Task not found.");

  let title = args.title;
  let summary = args.summary;

  if (args.ref_type === "task_ref") {
    title ??= task.display_name || task.project_name;
    summary ??= `${task.state} · ${task.source_type}`;
  }

  if (args.ref_type === "finding_ref") {
    if (!args.finding_key) return text("finding_key required for finding_ref.");
    const finding = await findingsStorage.getFindingByKey(args.task_id, args.finding_key);
    if (!finding) return text("Finding not found.");
    title ??= finding.vuln_type || finding.finding_key;
    summary ??= `${finding.severity} · ${finding.primary_file ?? "—"}${finding.primary_line ? `:${finding.primary_line}` : ""}`;
  }

  if (args.ref_type === "wiki_ref") {
    title ??= `${task.display_name || task.project_name} Wiki`;
    summary ??= args.section ? `Section: ${args.section}` : "Project knowledge";
  }

  if (args.ref_type === "report_ref") {
    if (!args.report_id) return text("report_id required for report_ref.");
    const reportStorage = await import("../../features/reports/storage.js");
    const report = await reportStorage.getReport(args.report_id);
    if (!report || report.task_id !== args.task_id) return text("Report not found.");
    title ??= report.skill_name || "Report";
    summary ??= `${report.status} · ${report.format ?? "report"}`;
  }

  return text(
    JSON.stringify(
      {
        type: args.ref_type,
        task_id: args.task_id,
        finding_key: args.finding_key,
        report_id: args.report_id,
        section: args.section,
        title,
        summary,
      },
      null,
      2,
    ),
  );
}

