/**
 * VulnHunt Worker Bridge — Chat Mode
 * Runs inside the worker container.
 * Spawns pi CLI in rpc mode, bridges stdio JSONL ↔ HTTP/WS.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { WebSocketServer, WebSocket } from "ws";

const PORT = Number(process.env.BRIDGE_PORT ?? "8080");
const SESSION_DIR = process.env.SESSION_DIR ?? "/workspace/chat-session";
const IDLE_TIMEOUT_MS = Number(process.env.IDLE_TIMEOUT_MIN ?? "10") * 60 * 1000;

// Model config from env
const MODEL_PROTO = process.env.MODEL_PROTO_TYPE ?? "openai";
const MODEL_NAME = process.env.LLM_MODEL_NAME ?? "";
const API_KEY = process.env.LLM_API_KEY ?? "";
const BASE_URL = process.env.LLM_BASE_URL ?? "";
const SERVICE_URL = process.env.SERVICE_URL ?? "";
const MCP_TOKEN = process.env.CHAT_WORKER_TOKEN ?? "";

// ─── Pi RPC Process ───

let pi: ChildProcess | null = null;
const wsClients = new Set<WebSocket>();
let lastActivity = Date.now();

function setupPiConfig(): void {
  // Create models.json for custom provider (openai-completions API)
  const piDir = join(process.env.HOME ?? "/root", ".pi", "agent");
  mkdirSync(piDir, { recursive: true });

  // models.json — register custom provider with correct API
  // Key insight: apiKey field is an ENV VAR NAME, not the actual key
  if (BASE_URL && API_KEY) {
    const providerKey = "vulnhunt";
    const api = MODEL_PROTO === "anthropic" ? "anthropic" : "openai-completions";
    process.env.VH_LLM_API_KEY = API_KEY; // Set actual key in env
    const modelsJson = {
      providers: {
        [providerKey]: {
          baseUrl: BASE_URL,
          api,
          apiKey: "VH_LLM_API_KEY", // env var name, pi reads the value from process.env
          models: [
            { id: MODEL_NAME, input: ["text"], contextWindow: 200000, maxTokens: 16384 },
          ],
        },
      },
    };
    writeFileSync(join(piDir, "models.json"), JSON.stringify(modelsJson, null, 2));
  }

  // Empty auth.json to prevent pi from complaining
  writeFileSync(join(piDir, "auth.json"), "{}");

  // MCP config for platform tools
  if (SERVICE_URL && MCP_TOKEN) {
    const mcpConfig = {
      mcpServers: {
        vulnhunt: {
          url: `${SERVICE_URL}/mcp`,
          headers: { Authorization: `Bearer ${MCP_TOKEN}` },
          directTools: true,
          lifecycle: "eager",
        },
      },
    };
    writeFileSync(join(piDir, "mcp.json"), JSON.stringify(mcpConfig, null, 2));
  }
}

function spawnPi(): ChildProcess {
  mkdirSync(SESSION_DIR, { recursive: true });
  const sessionFile = join(SESSION_DIR, "session.jsonl");

  const modelStr = BASE_URL
    ? `vulnhunt/${MODEL_NAME}`
    : `${MODEL_PROTO}/${MODEL_NAME}`;

  const args = [
    "--mode", "rpc",
    "--model", modelStr,
    "--no-skills",
    "--no-extensions",
    "-e", "pi-mcp-adapter",  // explicitly load MCP adapter only
    "--no-prompt-templates",
    "--no-themes",
  ];

  if (existsSync(sessionFile)) {
    args.push("--session", sessionFile);
  }

  console.log(`[bridge] Spawning pi: pi ${args.join(" ")}`);

  const piDir = join(process.env.HOME ?? "/root", ".pi", "agent");
  const child = spawn("pi", args, {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: "/workspace",
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: piDir, // Tell pi where to find models.json
    },
  });

  // Parse stdout JSONL → broadcast to WS clients
  const rl = createInterface({ input: child.stdout! });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    lastActivity = Date.now();
    console.log(`[pi stdout] ${line.substring(0, 120)}`);
    broadcastToClients(line);
  });

  // Log stderr
  const stderrRl = createInterface({ input: child.stderr! });
  stderrRl.on("line", (line) => {
    console.log(`[pi stderr] ${line}`);
  });

  child.on("exit", (code) => {
    console.log(`[bridge] pi exited with code ${code}`);
    pi = null;
  });

  return child;
}

function broadcastToClients(jsonLine: string): void {
  for (const ws of wsClients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(jsonLine);
    }
  }
}

function sendToPi(command: Record<string, unknown>): boolean {
  if (!pi || !pi.stdin || pi.stdin.destroyed) {
    console.warn("[bridge] pi not running, cannot send command");
    return false;
  }
  lastActivity = Date.now();
  pi.stdin.write(JSON.stringify(command) + "\n");
  return true;
}

// ─── HTTP Server ───

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const url = req.url ?? "";
  const method = req.method ?? "GET";

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (method === "POST" && url === "/chat/prompt") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const { message, images } = JSON.parse(body);
        const ok = sendToPi({ type: "prompt", message, images });
        res.writeHead(ok ? 200 : 503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok }));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Invalid JSON" }));
      }
    });
    return;
  }

  if (method === "POST" && url === "/chat/abort") {
    const ok = sendToPi({ type: "abort" });
    res.writeHead(ok ? 200 : 503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok }));
    return;
  }

  if (method === "GET" && url === "/chat/state") {
    const ok = sendToPi({ type: "get_state" });
    res.writeHead(ok ? 200 : 503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok, note: "State will be emitted on WS" }));
    return;
  }

  if (method === "GET" && url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, pi_running: pi !== null }));
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
}

// ─── Idle Timer ───

function startIdleTimer(): void {
  setInterval(() => {
    if (Date.now() - lastActivity > IDLE_TIMEOUT_MS) {
      console.log(`[bridge] Idle timeout (${IDLE_TIMEOUT_MS / 60000}min), shutting down`);
      if (pi) {
        pi.kill("SIGTERM");
      }
      process.exit(0);
    }
  }, 30_000);
}

// ─── Main ───

function main(): void {
  console.log("[bridge] Starting worker bridge...");
  setupPiConfig();

  const server = createServer(handleRequest);

  // WS server for event streaming
  const wss = new WebSocketServer({ server, path: "/chat/events" });
  wss.on("connection", (ws) => {
    console.log("[bridge] WS client connected");
    wsClients.add(ws);
    ws.on("close", () => wsClients.delete(ws));
    ws.on("error", () => wsClients.delete(ws));
  });

  // Spawn pi rpc
  pi = spawnPi();

  // Start idle timer
  startIdleTimer();

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`[bridge] Listening on :${PORT}`);
  });
}

main();
