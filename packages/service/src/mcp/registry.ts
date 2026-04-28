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
} from "./tools/query-tools.js";

/**
 * Register Chat Agent tools (excludes report-worker-only tools).
 */
export function registerChatTools(server: McpServer, _ctx: McpContext): void {
  server.tool("list-findings", listFindingsSchema, async (args) => listFindings(args as any));
  server.tool("read-finding", readFindingSchema, async (args) => readFinding(args as any));
  server.tool("list-tasks", listTasksSchema, async (args) => listTasks(args as any));
  server.tool("read-task-metadata", readTaskMetadataSchema, async (args) => readTaskMetadata(args as any));
  server.tool("cancel-task", cancelTaskSchema, async (args) => cancelTask(args as any));
  server.tool("create-task", createTaskSchema, async (args) => createMcpTask(args as any));

  // P0 query tools
  server.tool("get-platform-overview", getPlatformOverviewSchema, async () => getPlatformOverview());
  server.tool("get-task-detail", getTaskDetailSchema, async (args) => getTaskDetail(args as any));
  server.tool("get-task-events", getTaskEventsSchema, async (args) => getTaskEvents(args as any));

  // TODO P1: read-wiki, read-report, get-poc-results, prepare-source-context
  // TODO P1: control-task, generate-report, generate-poc, present-artifact
  // TODO P2: review-finding
}

/**
 * Register Report Worker tools only.
 */
export function registerReportTools(server: McpServer, _ctx: McpContext): void {
  server.tool("submit-report", submitReportSchema, async (args) => submitReport(args as any));
}
