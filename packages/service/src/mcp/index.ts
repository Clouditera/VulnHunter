/**
 * MCP Server — Hono route exposing platform tools to Chat agents and Report workers.
 *
 * Uses WebStandardStreamableHTTPServerTransport (stateful, per-pi-session).
 * Mounted at /mcp on the main service.
 *
 * Auth: Bearer <token> — resolved to McpContext (chat session or report).
 * Tool registry is split by actor type: Chat Agent vs Report Worker.
 */

import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { resolveMcpContext, type McpContext } from "./context.js";
import { registerChatTools, registerReportTools } from "./registry.js";
import { logger } from "../infra/logger.js";

// Per-MCP-session state
interface McpSession {
  transport: WebStandardStreamableHTTPServerTransport;
  server: McpServer;
  context: McpContext;
}
const mcpSessions = new Map<string, McpSession>();

function createToolServer(ctx: McpContext): McpServer {
  const server = new McpServer(
    { name: "vulnhunt", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  if (ctx.actorType === "chat") {
    registerChatTools(server, ctx);
  } else {
    registerReportTools(server, ctx);
  }

  return server;
}

export const mcpRouter = new Hono();

// Auth middleware — Bearer token resolved to McpContext
mcpRouter.use("*", async (c, next) => {
  const authHeader = c.req.header("authorization") ?? "";
  const token = authHeader.replace("Bearer ", "");

  if (!token) {
    return c.json({ error: "Missing Bearer token" }, 401);
  }

  const ctx = await resolveMcpContext(token);
  if (!ctx) {
    return c.json({ error: "Invalid session token" }, 401);
  }

  c.set("mcpContext" as never, ctx as never);
  return next();
});

// Handle all MCP requests (POST for RPC, GET for SSE, DELETE for session close)
mcpRouter.all("*", async (c) => {
  const mcpSessionId = c.req.header("mcp-session-id");

  // Existing session — route to its transport
  if (mcpSessionId && mcpSessions.has(mcpSessionId)) {
    const session = mcpSessions.get(mcpSessionId)!;
    return session.transport.handleRequest(c.req.raw);
  }

  // New session — initialize with context-aware tool registry
  const ctx = c.get("mcpContext" as never) as McpContext;

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sid) => {
      mcpSessions.set(sid, { transport, server, context: ctx });
      logger.info({ mcpSessionId: sid, actorType: ctx.actorType, userId: ctx.userId }, "MCP session initialized");
    },
    onsessionclosed: (sid) => {
      mcpSessions.delete(sid);
      logger.info({ mcpSessionId: sid }, "MCP session closed");
    },
  });

  const server = createToolServer(ctx);
  await server.connect(transport);

  return transport.handleRequest(c.req.raw);
});
