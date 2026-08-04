/**
 * MCP tool registry — split by consumer type.
 * Chat Agent gets platform query + operation tools.
 * Report Worker gets only submit-report.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpContext } from "./context.js";
import {
  listFindingsSchema,
  listFindings,
  readFindingSchema,
  readFinding,
  listTasksSchema,
  listTasks,
  readTaskMetadataSchema,
  readTaskMetadata,
  cancelTaskSchema,
  cancelTask,
  createTaskSchema,
  createMcpTask,
  submitReportSchema,
  submitReport,
} from "./tools.js";
import {
  getPlatformOverviewSchema,
  getPlatformOverview,
  getTaskDetailSchema,
  getTaskDetail,
  getTaskEventsSchema,
  getTaskEvents,
  readWikiSchema,
  readWiki,
  readReportSchema,
  readReport,
  emitReferenceSchema,
  emitReference,
} from "./tools/query-tools.js";
import {
  controlTaskSchema,
  controlTask,
  generateReportSchema,
  generateReport,
  presentArtifactSchema,
  presentArtifact,
} from "./tools/action-tools.js";

/**
 * Register Chat Agent tools (excludes report-worker-only tools).
 */
export function registerChatTools(server: McpServer, ctx: McpContext): void {
  server.tool("list-findings", listFindingsSchema, async (args) => listFindings(args as any, ctx));
  server.tool("read-finding", readFindingSchema, async (args) => readFinding(args as any, ctx));
  server.tool("list-tasks", listTasksSchema, async (args) => listTasks(args as any, ctx));
  server.tool("read-task-metadata", readTaskMetadataSchema, async (args) =>
    readTaskMetadata(args as any, ctx),
  );
  server.tool("cancel-task", cancelTaskSchema, async (args) => cancelTask(args as any, ctx));
  server.tool("create-task", createTaskSchema, async (args) => createMcpTask(args as any, ctx));

  // P0 query tools
  server.tool("get-platform-overview", getPlatformOverviewSchema, async () =>
    getPlatformOverview(ctx),
  );
  server.tool("get-task-detail", getTaskDetailSchema, async (args) => getTaskDetail(args as any, ctx));
  server.tool("get-task-events", getTaskEventsSchema, async (args) => getTaskEvents(args as any, ctx));

  // P1 query tools
  server.tool("read-wiki", readWikiSchema, async (args) => readWiki(args as any, ctx));
  server.tool("read-report", readReportSchema, async (args) => readReport(args as any, ctx));
  server.tool(
    "emit-reference",
    "向用户呈现平台中已存在实体（任务 / 漏洞 / 知识库 Wiki / 报告）的可交互卡片。卡片可点击，用户点开后在右侧面板查看该实体的实时详情（状态、进展、漏洞分布、报告预览等）。" +
      "使用时机：当你查询到某个任务/漏洞/Wiki/报告、或用户想查看它们时，调用本工具把它呈现为卡片。" +
      "重要：输出 Markdown 表格、文字列表或「📋 任务卡片」之类的纯文字描述，都不等于呈现卡片，用户看不到可交互卡片。要让用户看到卡片，必须调用本工具——这是唯一方式。",
    emitReferenceSchema,
    async (args) => emitReference(args as any, ctx),
  );

  // P1 action tools
  server.tool("control-task", controlTaskSchema, async (args) => controlTask(args as any, ctx));
  server.tool("generate-report", generateReportSchema, async (args) =>
    generateReport(args as any, ctx),
  );
  server.tool(
    "present-artifact",
    "向用户呈现你自己生成的自由内容（分析总结、对比表、自定义视图、导出的脚本/配置等平台中本不存在、由你创造的内容）的可预览文件卡片。用户可点开在右侧面板预览并下载。" +
      "使用时机：当你整理出分析结论、对比数据，或生成需要让用户查看/下载的文件时调用。" +
      "重要：直接在回复里贴大段文字或 Markdown 不等于呈现可预览文件，用户无法预览或下载。要交付可预览/可下载的内容，必须调用本工具。" +
      "注意区分：呈现平台已有实体（任务/漏洞/Wiki/报告）请用 emit-reference，本工具仅用于你新创造的内容。",
    presentArtifactSchema,
    async (args) => presentArtifact(args as any, ctx),
  );

  // TODO P1: prepare-source-context
  // TODO P2: review-finding
}

/**
 * Register Report Worker tools only.
 */
export function registerReportTools(server: McpServer, _ctx: McpContext): void {
  server.tool("submit-report", submitReportSchema, async (args) => submitReport(args as any));
}
