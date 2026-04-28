/**
 * VulnHunt Worker Bridge — Chat + Report Modes
 * Runs inside the worker container.
 * Spawns pi CLI in rpc mode, bridges stdio JSONL ↔ HTTP/WS.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { writeFileSync, mkdirSync, existsSync, createWriteStream } from "node:fs";
import { join } from "node:path";
import { WebSocketServer, WebSocket } from "ws";

const PORT = Number(process.env.BRIDGE_PORT ?? "8080");
const MODE = process.env.MODE ?? "chat";
const SESSION_DIR = process.env.SESSION_DIR ?? "/workspace/chat-session";
const IDLE_TIMEOUT_MS = Number(process.env.IDLE_TIMEOUT_MIN ?? "10") * 60 * 1000;

// Report mode specific
const SKILL_PATH = process.env.SKILL_PATH ?? "";
const REPORT_SYSTEM_PROMPT = process.env.REPORT_SYSTEM_PROMPT ?? "";
const TASK_ID = process.env.TASK_ID ?? "";

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

const PROTO_API_MAP: Record<string, string> = {
  "openai": "openai-completions",
  "openai-completions": "openai-completions",
  "openai-responses": "openai-responses",
  "anthropic": "anthropic",
};

// Credential ID → provider key mapping for set_model
const credProviderMap = new Map<string, { providerKey: string; modelId: string }>();

function setupPiConfig(): void {
  const piDir = join(process.env.HOME ?? "/root", ".pi", "agent");
  mkdirSync(piDir, { recursive: true });

  const providers: Record<string, unknown> = {};

  // Register primary credential
  if (BASE_URL && API_KEY) {
    const api = PROTO_API_MAP[MODEL_PROTO];
    if (!api) {
      console.error(`[bridge] Unknown MODEL_PROTO_TYPE: "${MODEL_PROTO}". Valid: ${Object.keys(PROTO_API_MAP).join(", ")}`);
      process.exit(1);
    }
    const providerKey = "vulnhunt";
    process.env.VH_LLM_API_KEY = API_KEY;
    providers[providerKey] = {
      baseUrl: BASE_URL,
      api,
      apiKey: "VH_LLM_API_KEY",
      models: [{ id: MODEL_NAME, input: ["text", "image"], contextWindow: 200000, maxTokens: 16384 }],
    };
  }

  // Register all additional credentials for runtime switching
  const allCredsJson = process.env.ALL_CREDENTIALS;
  if (allCredsJson) {
    try {
      const allCreds = JSON.parse(allCredsJson) as Array<{
        id: string; label: string; proto_type: string;
        base_url: string; api_key: string; model_id: string;
      }>;
      for (const cred of allCreds) {
        const api = PROTO_API_MAP[cred.proto_type];
        if (!api) continue;
        const providerKey = `vh-${cred.id.slice(0, 8)}`;
        const apiKeyEnv = `VH_KEY_${cred.id.replace(/-/g, "_").slice(0, 12).toUpperCase()}`;
        process.env[apiKeyEnv] = cred.api_key;

        // Skip if same provider already registered (primary credential)
        if (!providers[providerKey]) {
          providers[providerKey] = {
            baseUrl: cred.base_url,
            api,
            apiKey: apiKeyEnv,
            models: [{ id: cred.model_id, input: ["text", "image"], contextWindow: 200000, maxTokens: 16384 }],
          };
        }
        credProviderMap.set(cred.id, { providerKey, modelId: cred.model_id });
      }
      console.log(`[bridge] Registered ${Object.keys(providers).length} model providers`);
    } catch (err) {
      console.error(`[bridge] Failed to parse ALL_CREDENTIALS:`, err);
    }
  }

  if (Object.keys(providers).length > 0) {
    writeFileSync(join(piDir, "models.json"), JSON.stringify({ providers }, null, 2));
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
    "-e", "/usr/local/lib/node_modules/pi-mcp-adapter",
    "--no-prompt-templates",
    "--no-themes",
  ];

  // Report mode: inject skill + print flag
  if (MODE === "report" && SKILL_PATH) {
    args.push("--skill", SKILL_PATH);
  }

  // Chat mode: inject platform assistant skill
  const CHAT_SKILL_PATH = process.env.CHAT_SKILL_PATH ?? "/opt/vulnhunt/flows/vulnhunt-chat/skills/platform-assistant";
  if (MODE === "chat") {
    args.push("--skill", CHAT_SKILL_PATH);
  }

  if (MODE === "report" && REPORT_SYSTEM_PROMPT) {
    args.push("--system-prompt", REPORT_SYSTEM_PROMPT);
  }

  // Always pass --session so pi persists conversation history.
  // On first run it creates the file; on subsequent runs it resumes from it.
  args.push("--session", sessionFile);

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

  // Report mode: write events to a JSONL file for service event tailing
  let reportEventsStream: import("fs").WriteStream | null = null;
  if (MODE === "report") {
    const eventsDir = join("/workspace", ".report", "events");
    mkdirSync(eventsDir, { recursive: true });
    reportEventsStream = createWriteStream(join(eventsDir, "report.service.jsonl"), { flags: "a" });
  }

  // Parse stdout JSONL → broadcast to WS clients + write report events
  const rl = createInterface({ input: child.stdout! });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    lastActivity = Date.now();
    console.log(`[pi stdout] ${line.substring(0, 120)}`);
    broadcastToClients(line);

    // Write to report events file for LiveLog
    if (reportEventsStream) {
      try {
        const parsed = JSON.parse(line);
        // Translate pi RPC events to service event format
        if (parsed.type === "tool_execution_start" || parsed.type === "tool_execution_end") {
          const evt = {
            timestamp: new Date().toISOString(),
            event: "tool_call",
            tool: parsed.tool_name ?? parsed.name ?? "unknown",
            status: parsed.type === "tool_execution_end" ? (parsed.error ? "error" : "success") : "running",
            source: "report",
          };
          reportEventsStream.write(JSON.stringify(evt) + "\n");
        } else if (parsed.type === "message_start" || parsed.type === "turn_start") {
          const evt = {
            timestamp: new Date().toISOString(),
            event: "task_status",
            message: "Report generation in progress...",
            source: "report",
          };
          reportEventsStream.write(JSON.stringify(evt) + "\n");
        }
      } catch { /* not valid JSON or unrecognized event */ }
    }
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

  if (method === "POST" && url === "/chat/set-model") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const { credentialId } = JSON.parse(body);
        const mapping = credProviderMap.get(credentialId);
        if (!mapping) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Credential not registered" }));
          return;
        }
        const ok = sendToPi({ type: "set_model", provider: mapping.providerKey, modelId: mapping.modelId });
        console.log(`[bridge] set_model → provider=${mapping.providerKey}, model=${mapping.modelId}`);
        res.writeHead(ok ? 200 : 503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok, provider: mapping.providerKey, modelId: mapping.modelId }));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Invalid JSON" }));
      }
    });
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

  // Report mode: auto-inject the generation prompt after a short delay
  if (MODE === "report" && TASK_ID) {
    setTimeout(() => {
      const prompt = [
        `请为任务 ${TASK_ID} 生成安全报告。`,
        `严格遵循已加载的 Skill 指引（报告格式、语言、评估标准）。`,
        `使用 MCP 工具获取 findings 数据，然后按 Skill 要求输出报告文件到 /workspace/reports/。`,
        `完成后调用 submit-report 提交报告。`,
      ].join("\n");
      console.log("[bridge] Injecting report generation prompt");
      sendToPi({ type: "prompt", message: prompt });
    }, 3000);
  }

  // Start idle timer
  startIdleTimer();

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`[bridge] Listening on :${PORT}`);
  });
}

main();
