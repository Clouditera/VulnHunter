/**
 * MCP tool registry — split by consumer type.
 * Chat Agent gets platform query + operation tools.
 * Report Worker gets only submit-report.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpContext } from "./context.js";
import {
  listFindingsSchema, listFindings,
  readFindingSchema, readFinding,
  listTasksSchema, listTasks,
  readTaskMetadataSchema, readTaskMetadata,
  cancelTaskSchema, cancelTask,
  createTaskSchema, createMcpTask,
  submitReportSchema, submitReport,
} from "./tools.js";
import {
  getPlatformOverviewSchema, getPlatformOverview,
  getTaskDetailSchema, getTaskDetail,
  getTaskEventsSchema, getTaskEvents,
  readWikiSchema, readWiki,
  readReportSchema, readReport,
  getPocResultsSchema, getPocResults,
} from "./tools/query-tools.js";
import {
  controlTaskSchema, controlTask,
  generateReportSchema, generateReport,
  generatePocSchema, generatePoc,
  presentArtifactSchema, presentArtifact,
} from "./tools/action-tools.js";

/**
 * Register Chat Agent tools (excludes report-worker-only tools).
 */
export function registerChatTools(server: McpServer, ctx: McpContext): void {
  server.tool("list-findings", listFindingsSchema, async (args) => listFindings(args as any));
  server.tool("read-finding", readFindingSchema, async (args) => readFinding(args as any));
  server.tool("list-tasks", listTasksSchema, async (args) => listTasks(args as any));
  server.tool("read-task-metadata", readTaskMetadataSchema, async (args) => readTaskMetadata(args as any));
  server.tool("cancel-task", cancelTaskSchema, async (args) => cancelTask(args as any, ctx));
  server.tool("create-task", createTaskSchema, async (args) => createMcpTask(args as any, ctx));

  // P0 query tools
  server.tool("get-platform-overview", getPlatformOverviewSchema, async () => getPlatformOverview());
  server.tool("get-task-detail", getTaskDetailSchema, async (args) => getTaskDetail(args as any));
  server.tool("get-task-events", getTaskEventsSchema, async (args) => getTaskEvents(args as any));

  // P1 query tools
  server.tool("read-wiki", readWikiSchema, async (args) => readWiki(args as any));
  server.tool("read-report", readReportSchema, async (args) => readReport(args as any));
  server.tool("get-poc-results", getPocResultsSchema, async (args) => getPocResults(args as any));

  // P1 action tools
  server.tool("control-task", controlTaskSchema, async (args) => controlTask(args as any, ctx));
  server.tool("generate-report", generateReportSchema, async (args) => generateReport(args as any, ctx));
  server.tool("generate-poc", generatePocSchema, async (args) => generatePoc(args as any, ctx));
  server.tool("present-artifact", presentArtifactSchema, async (args) => presentArtifact(args as any, ctx));

  // TODO P1: prepare-source-context
  // TODO P2: review-finding
}

/**
 * Register Report Worker tools only.
 */
export function registerReportTools(server: McpServer, _ctx: McpContext): void {
  server.tool("submit-report", submitReportSchema, async (args) => submitReport(args as any));
}
