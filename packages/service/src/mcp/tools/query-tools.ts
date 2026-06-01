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
}): Promise<ToolResult> {
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

// ─── read-wiki (P1) ───

export const readWikiSchema = {
  task_id: z.string().describe("The task ID"),
  section: z
    .enum(["profile", "features", "groups", "all"])
    .optional()
    .default("all")
    .describe("Wiki section"),
};

export async function readWiki(args: { task_id: string; section?: string }): Promise<ToolResult> {
  try {
    const config = (await import("../../infra/config.js")).loadConfig();
    const minio = (await import("../../infra/minio/client.js")).getMinio();

    // Try to load project profiler
    const profilerKey = `scan-outputs/${args.task_id}/profiler/project-profiler.yaml`;
    try {
      const stream = await minio.getObject(config.minio.bucket, profilerKey);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      const content = Buffer.concat(chunks).toString("utf-8");
      return text(`# Project Wiki\n\n${content}`);
    } catch {
      return text("No wiki/profiler data available for this task.");
    }
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
}): Promise<ToolResult> {
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
}): Promise<ToolResult> {
  const task = await taskStorage.getTaskById(args.task_id);
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

// ─── get-poc-results (P1) ───

export const getPocResultsSchema = {
  task_id: z.string().describe("The task ID"),
  finding_key: z.string().optional().describe("Specific finding key for detailed result"),
};

export async function getPocResults(args: {
  task_id: string;
  finding_key?: string;
}): Promise<ToolResult> {
  const pocStorage = await import("../../features/poc/storage.js");
  const results = await pocStorage.listPocResults(args.task_id);

  if (results.length === 0) return text("No POC results found for this task.");

  if (args.finding_key) {
    const result = results.find((r) => r.finding_key === args.finding_key);
    if (!result) return text(`No POC result for finding ${args.finding_key}.`);

    const lines = [
      `## POC Result: ${result.finding_key}`,
      `- **Status**: ${result.status}`,
      result.evidence ? `- **Evidence**: ${result.evidence}` : null,
      result.poc_script_minio_key ? `- **Script**: available` : null,
    ].filter(Boolean);
    return text(lines.join("\n"));
  }

  // Summary of all results
  const lines = [
    `# POC Results (${results.length} total)`,
    "",
    ...results.map(
      (r) =>
        `- **${r.finding_key}**: ${r.status}${r.evidence ? ` — ${String(r.evidence).slice(0, 100)}` : ""}`,
    ),
  ];
  return text(lines.join("\n"));
}
