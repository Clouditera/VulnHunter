/**
 * VulnAgent Worker Bridge — Chat + Report Modes
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
  "你是 VulnAgent 代码安全审计平台的 AI 助手。用户通过聊天窗口与你交流，你帮他们完成安全扫描、查看结果、生成报告等操作。",
  "",
  "你的沟通方式：用简洁自然的中文，像安全顾问一样和用户对话。用项目名称指代任务，用通俗语言解释安全概念。",
  "",
  "VulnAgent 平台的核心能力：",
  "- 用户提供 Git 仓库地址或上传项目压缩包，平台会自动进行深度代码安全审计",
  "- 审计产出两类结果：漏洞（已确认可利用的安全问题）和风险（存在隐患但难以直接利用）",
  "- 每个结果包含 CVSS 标准评分和 EV（Exploit Value，从攻击者视角评估漏洞的实际利用价值和优先级）评估，帮助用户判断优先级",
  "- 审计过程中自动构建项目安全知识库，记录对各模块的分析",
  "- 用户可以设定审计关注面（如“聚焦认证逻辑”）和扫描时长",
  "- 扫描完成后可以继续深入，在已有发现基础上进一步探索",
  "- 平台支持生成专业安全审计报告，以及 POC 验证漏洞可利用性",
  "",
  "创建扫描任务时，逐步和用户确认项目来源、关注方向、扫描时长，信息齐备后再创建。",
  "",
  "所有平台数据通过工具获取和操作。身份和模型凭证由平台自动绑定。",
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
const noAuthProxyTargets = new Map<string, string>();
const NO_AUTH_DUMMY_KEY = "vulnagent-no-auth";

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function noAuthProxyBaseUrl(targetKey: string): string {
  return `http://127.0.0.1:${PORT}/_llm_proxy/${encodeURIComponent(targetKey)}`;
}

function setupPiConfig(): void {
  const piDir = join(process.env.HOME ?? "/root", ".pi", "agent");
  mkdirSync(piDir, { recursive: true });

  const providers: Record<string, unknown> = {};

  // Register primary credential
  if (BASE_URL) {
    const api = PROTO_API_MAP[MODEL_PROTO];
    if (!api) {
      console.error(`[bridge] Unknown MODEL_PROTO_TYPE: "${MODEL_PROTO}". Valid: ${Object.keys(PROTO_API_MAP).join(", ")}`);
      process.exit(1);
    }
    const providerKey = "vulnagent";
    const providerConfig: Record<string, unknown> = {
      baseUrl: API_KEY ? BASE_URL : noAuthProxyBaseUrl("primary"),
      api,
      models: [{ id: MODEL_NAME, input: ["text", "image"], contextWindow: CONTEXT_WINDOW, maxTokens: 16384 }],
    };
    process.env.VH_LLM_API_KEY = API_KEY || NO_AUTH_DUMMY_KEY;
    providerConfig.apiKey = "VH_LLM_API_KEY";
    if (!API_KEY) {
      noAuthProxyTargets.set("primary", stripTrailingSlash(BASE_URL));
    }
    providers[providerKey] = providerConfig;
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
        const providerKey = `va-${cred.id.slice(0, 8)}`;
        const apiKeyEnv = `VH_KEY_${cred.id.replace(/-/g, "_").slice(0, 12).toUpperCase()}`;

        // Skip if same provider already registered (primary credential)
        if (!providers[providerKey]) {
          const providerConfig: Record<string, unknown> = {
            baseUrl: cred.api_key ? cred.base_url : noAuthProxyBaseUrl(cred.id),
            api,
            models: [{ id: cred.model_id, input: ["text", "image"], contextWindow: parsePositiveInt(String(cred.context_window_tokens ?? ""), DEFAULT_CONTEXT_WINDOW_TOKENS), maxTokens: 16384 }],
          };
          process.env[apiKeyEnv] = cred.api_key || NO_AUTH_DUMMY_KEY;
          providerConfig.apiKey = apiKeyEnv;
          if (!cred.api_key) {
            noAuthProxyTargets.set(cred.id, stripTrailingSlash(cred.base_url));
          }
          providers[providerKey] = providerConfig;
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
        vulnagent: {
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
    ? `vulnagent/${MODEL_NAME}`
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

  // Chat mode: identity and behavior come from the system prompt + tool
  // describes. No skill is loaded — the system prompt is the single source of
  // the agent's persona and platform knowledge.
  if (MODE === "chat") {
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
        ? `vulnagent/${MODEL_NAME}`
        : `${MODEL_PROTO}/${MODEL_NAME}`;
    const piDir = join(process.env.HOME ?? "/root", ".pi", "agent");
    const tmpSession = join(mkdtempSync(join(tmpdir(), "va-chat-title-")), "session.jsonl");
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

async function proxyNoAuthRequest(req: IncomingMessage, res: ServerResponse, url: string): Promise<void> {
  const match = url.match(/^\/_llm_proxy\/([^/]+)(\/.*)?$/);
  const key = match ? decodeURIComponent(match[1]) : "";
  const suffix = match?.[2] ?? "";
  const targetBase = noAuthProxyTargets.get(key);
  if (!targetBase) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "No no-auth proxy target" }));
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase();
    if (lower === "host" || lower === "authorization" || lower === "x-api-key" || lower === "content-length") continue;
    if (Array.isArray(value)) headers.set(name, value.join(", "));
    else if (value != null) headers.set(name, value);
  }
  try {
    const upstream = await fetch(`${targetBase}${suffix}`, { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined });
    res.writeHead(upstream.status, Object.fromEntries(upstream.headers.entries()));
    res.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  }
}

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const url = req.url ?? "";
  const method = req.method ?? "GET";

  if (url.startsWith("/_llm_proxy/")) {
    void proxyNoAuthRequest(req, res, url);
    return;
  }

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
