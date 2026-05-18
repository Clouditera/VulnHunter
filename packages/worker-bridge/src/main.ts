/**
 * VulnHunt Worker Bridge — Chat + Report Modes
 * Runs inside the worker container.
 * Spawns pi CLI in rpc mode, bridges stdio JSONL ↔ HTTP/WS.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { writeFileSync, mkdirSync, existsSync, createWriteStream, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebSocketServer, WebSocket } from "ws";

const PORT = Number(process.env.BRIDGE_PORT ?? "8080");
const MODE = process.env.MODE ?? "chat";
const SESSION_DIR = process.env.SESSION_DIR ?? "/workspace/chat-session";
const IDLE_TIMEOUT_MS = Number(process.env.IDLE_TIMEOUT_MIN ?? "10") * 60 * 1000;

// Report mode specific
const SKILL_PATH = process.env.SKILL_PATH ?? "";
const REPORT_SYSTEM_PROMPT = process.env.REPORT_SYSTEM_PROMPT ?? "";

const CHAT_SYSTEM_PROMPT = [
  "你是 VulnHunt 安全漏洞扫描平台的专属 AI 助手，不是通用编程助手。",
  "",
  "核心规则：",
  "1. 凡是用户询问平台数据（任务、漏洞、报告、POC、日志、统计），第一步必须使用 VulnHunt MCP 工具。禁止使用 read/bash/ls 等文件系统工具查询平台数据。",
  "2. 如果用户要求“列出任务”，必须调用 list-tasks。",
  "3. 如果用户询问“任务进度”，必须调用 get-task-detail 和 get-task-events。",
  "4. 如果用户询问“漏洞详情”，必须调用 read-finding。",
  "5. 如果用户询问“平台能做什么”，直接回答 VulnHunt 平台能力，不需要调用工具。",
  "6. 危险操作（取消任务、重启任务）前必须向用户确认。",
  "7. 当前 Chat 会话的前文就是你的可用上下文。用户问“刚才/此前/我们聊了什么/你还记得吗”时，必须直接根据当前对话上下文总结，不要调用 MCP，也不要调用 mcp action=ui-messages；只有用户明确要求查询其他历史会话时，才说明不能访问其他会话。",
  "8. 创建扫描任务时不要向用户索要 credential_id、user_id、tenant_id 或 session_id。create-task 会使用当前 Chat 会话选择的模型凭证。",
  "9. 如果用户上传附件并要求扫描，且消息包含 artifact_id，直接调用 create-task({ attachment_id, project_name? })；不要因为缺少 credential_id 反问用户。",
  "10. 默认使用中文回答。",
].join("\n");
const TASK_ID = process.env.TASK_ID ?? "";

// Model config from env
const MODEL_PROTO = process.env.MODEL_PROTO_TYPE ?? "openai";
const MODEL_NAME = process.env.LLM_MODEL_NAME ?? "";
const API_KEY = process.env.LLM_API_KEY ?? "";
const BASE_URL = process.env.LLM_BASE_URL ?? "";
const SERVICE_URL = process.env.SERVICE_URL ?? "";
const MCP_TOKEN = process.env.CHAT_WORKER_TOKEN ?? "";
const DEFAULT_CONTEXT_WINDOW_TOKENS = 128000;
const CONTEXT_WINDOW = parsePositiveInt(process.env.LLM_CONTEXT_WINDOW_TOKENS, DEFAULT_CONTEXT_WINDOW_TOKENS);

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
      models: [{ id: MODEL_NAME, input: ["text", "image"], contextWindow: CONTEXT_WINDOW, maxTokens: 16384 }],
    };
  }

  // Register all additional credentials for runtime switching
  const allCredsJson = process.env.ALL_CREDENTIALS;
  if (allCredsJson) {
    try {
      const allCreds = JSON.parse(allCredsJson) as Array<{
        id: string; label: string; proto_type: string;
        base_url: string; api_key: string; model_id: string; context_window_tokens?: number;
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
            models: [{ id: cred.model_id, input: ["text", "image"], contextWindow: parsePositiveInt(String(cred.context_window_tokens ?? ""), DEFAULT_CONTEXT_WINDOW_TOKENS), maxTokens: 16384 }],
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

  // Chat mode: inject platform assistant skill + system prompt for strong identity binding
  const CHAT_SKILL_PATH = process.env.CHAT_SKILL_PATH ?? "/opt/vulnhunt/flows/vulnhunt-chat/skills/platform-assistant";
  if (MODE === "chat") {
    args.push("--skill", CHAT_SKILL_PATH);
    args.push("--system-prompt", CHAT_SYSTEM_PROMPT);
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

function sanitizeTitle(raw: string): string {
  let title = raw
    .trim()
    .replace(/^```[a-zA-Z]*\s*/, "")
    .replace(/```$/g, "")
    .trim()
    .replace(/^标题[:：]\s*/, "")
    .replace(/[\r\n]+/g, " ")
    .replace(/[\"'“”‘’`]/g, "")
    .replace(/[。！？!?.,，、；;：:]+$/g, "")
    .trim();
  title = title.split(/[。！？!?\n]/)[0]?.trim() ?? title;
  if (title.length > 20) title = title.slice(0, 20).trim();
  return title;
}

function extractAssistantText(event: Record<string, any>): string {
  const message = event.message;
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content
    .filter((b: any) => b?.type === "text" && typeof b.text === "string")
    .map((b: any) => b.text)
    .join("\n");
}

function generateTitle(messages: Array<{ role: string; content: string }>, credentialId?: string): Promise<string> {
  return new Promise((resolve) => {
    const mapping = credentialId ? credProviderMap.get(credentialId) : undefined;
    const modelStr = mapping
      ? `${mapping.providerKey}/${mapping.modelId}`
      : BASE_URL
        ? `vulnhunt/${MODEL_NAME}`
        : `${MODEL_PROTO}/${MODEL_NAME}`;
    const piDir = join(process.env.HOME ?? "/root", ".pi", "agent");
    const tmpSession = join(mkdtempSync(join(tmpdir(), "vh-chat-title-")), "session.jsonl");
    const prompt = [
      "请根据下面第一轮对话生成一个会话标题。",
      "要求：中文优先，8到20个字；只输出标题本身；不要引号、编号、解释或句末标点；不要写泛泛的“安全分析”“问题咨询”。",
      "",
      ...messages.map((m) => `${m.role === "assistant" ? "assistant" : "user"}: ${m.content.slice(0, 1600)}`),
    ].join("\n");
    const args = [
      "-p",
      "--mode", "json",
      "--model", modelStr,
      "--no-skills",
      "--no-extensions",
      "--no-tools",
      "--no-prompt-templates",
      "--no-themes",
      "--session", tmpSession,
      "--system-prompt", "你是对话标题生成器。只输出一个简短中文标题，不输出解释。",
    ];
    const child = spawn("pi", args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: "/workspace",
      env: { ...process.env, PI_CODING_AGENT_DIR: piDir },
    });
    let title = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve(title);
    }, 18_000);
    const rl = createInterface({ input: child.stdout! });
    rl.on("line", (line) => {
      try {
        const event = JSON.parse(line);
        if (event.type === "message_end") {
          const text = extractAssistantText(event);
          if (text) title = sanitizeTitle(text);
        }
      } catch { /* ignore non-json */ }
    });
    child.stderr?.on("data", (buf) => console.log(`[title stderr] ${String(buf).trim()}`));
    child.on("exit", () => {
      clearTimeout(timer);
      resolve(title);
    });
    child.stdin?.end(prompt + "\n");
  });
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

  if (method === "POST" && url === "/chat/title") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const { messages, credentialId } = JSON.parse(body) as { messages?: Array<{ role: string; content: string }>; credentialId?: string };
        if (!Array.isArray(messages) || messages.length === 0) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "messages required" }));
          return;
        }
        generateTitle(messages, credentialId).then((title) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, title }));
        }).catch((err) => {
          console.log("[bridge] title generation failed", err);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, title: "" }));
        });
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Invalid JSON" }));
      }
    });
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

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const value = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(value) || value < 1000 || value > 10000000) return fallback;
  return value;
}
