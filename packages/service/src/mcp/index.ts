/**
 * MCP Server — Hono route exposing platform tools to Chat agents.
 *
 * Uses WebStandardStreamableHTTPServerTransport (stateful, per-pi-session).
 * Mounted at /mcp on the main service.
 *
 * Auth: Bearer <sessionId> — validated against active chat sessions.
 */

import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import * as chatStorage from "../features/chat/storage.js";
import * as reportStorage from "../features/reports/storage.js";
import { logger } from "../infra/logger.js";
import {
  listFindingsSchema, listFindings,
  readFindingSchema, readFinding,
  readTaskMetadataSchema, readTaskMetadata,
  listTasksSchema, listTasks,
  cancelTaskSchema, cancelTask,
  submitReportSchema, submitReport,
} from "./tools.js";

// Per-MCP-session state (each pi instance gets its own session)
interface McpSession {
  transport: WebStandardStreamableHTTPServerTransport;
  server: McpServer;
}
const mcpSessions = new Map<string, McpSession>();

function createToolServer(): McpServer {
  const server = new McpServer(
    { name: "vulnhunt", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.tool(
    "list-findings",
    "List security findings/vulnerabilities for a task. Returns finding keys, severities, types, and locations.",
    listFindingsSchema,
    async (args) => listFindings(args),
  );

  server.tool(
    "read-finding",
    "Read detailed information about a specific finding, including description, remediation, data flow, and code.",
    readFindingSchema,
    async (args) => readFinding(args),
  );

  server.tool(
    "read-task-metadata",
    "Read task metadata including project profile, execution summary, and findings count breakdown.",
    readTaskMetadataSchema,
    async (args) => readTaskMetadata(args),
  );

  server.tool(
    "list-tasks",
    "List scan tasks with their status, project name, and creation date. Optionally filter by state.",
    listTasksSchema,
    async (args) => listTasks(args),
  );

  server.tool(
    "cancel-task",
    "Cancel a running, paused, or queued scan task.",
    cancelTaskSchema,
    async (args) => cancelTask(args),
  );

  server.tool(
    "submit-report",
    "Submit a completed report. Called by the report agent after writing report files to /workspace/reports/.",
    submitReportSchema,
    async (args) => submitReport(args),
  );

  return server;
}

export const mcpRouter = new Hono();

// Auth middleware — Bearer token is the chat session ID
mcpRouter.use("*", async (c, next) => {
  const authHeader = c.req.header("authorization") ?? "";
  const token = authHeader.replace("Bearer ", "");

  if (!token) {
    return c.json({ error: "Missing Bearer token" }, 401);
  }

  // Validate token is an active chat session OR report
  const chatSession = await chatStorage.getSession(token);
  const report = chatSession ? null : await reportStorage.getReport(token);
  if (!chatSession && !report) {
    return c.json({ error: "Invalid session token" }, 401);
  }

  return next();
});

// Handle all MCP requests (POST for RPC, GET for SSE, DELETE for session close)
mcpRouter.all("*", async (c) => {
  const sessionId = c.req.header("mcp-session-id");

  // Existing session — route to its transport
  if (sessionId && mcpSessions.has(sessionId)) {
    const session = mcpSessions.get(sessionId)!;
    return session.transport.handleRequest(c.req.raw);
  }

  // New session — initialize request
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sid) => {
      mcpSessions.set(sid, { transport, server });
      logger.info({ mcpSessionId: sid }, "MCP session initialized");
    },
    onsessionclosed: (sid) => {
      mcpSessions.delete(sid);
      logger.info({ mcpSessionId: sid }, "MCP session closed");
    },
  });

  const server = createToolServer();
  await server.connect(transport);

  return transport.handleRequest(c.req.raw);
});
