/**
 * VulnHunter Worker Bridge — Chat + Report Modes
 * Runs inside the worker container.
 * Spawns pi CLI in rpc mode, bridges stdio JSONL ↔ HTTP/WS.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { writeFileSync, mkdirSync, createWriteStream, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebSocketServer, WebSocket } from "ws";
import { normalizeToolEventLine } from "./tool-event-normalize.js";
import { RpcCommandTracker } from "./rpc-command-tracker.js";
import { piApiForProtocol, SUPPORTED_MODEL_PROTOCOLS } from "./model-config.js";

const PORT = Number(process.env.BRIDGE_PORT ?? "8080");
const MODE = process.env.MODE ?? "chat";
const SESSION_DIR = process.env.SESSION_DIR ?? "/workspace/chat-session";
const IDLE_TIMEOUT_MS = Number(process.env.IDLE_TIMEOUT_MIN ?? "10") * 60 * 1000;

// Report mode specific
const SKILL_PATH = process.env.SKILL_PATH ?? "";
const REPORT_SYSTEM_PROMPT = process.env.REPORT_SYSTEM_PROMPT ?? "";

const CHAT_SYSTEM_PROMPT = [
  "你是 VulnHunter 代码安全审计平台的 AI 助手。用户通过聊天窗口与你交流，你帮他们完成安全扫描、查看结果、生成报告等操作。",
  "",
  "你的沟通方式：用简洁自然的中文，像安全顾问一样和用户对话。用项目名称指代任务，用通俗语言解释安全概念。",
  "",
  "VulnHunter 平台的核心能力：",
  "- 用户提供 Git 仓库地址或上传项目压缩包，平台会自动进行深度代码安全审计",
  "- 审计产出两类结果：漏洞（已确认可利用的安全问题）和风险（存在隐患但难以直接利用）",
  "- 每个结果包含 CVSS 标准评分和 EV（Exploit Value，从攻击者视角评估漏洞的实际利用价值和优先级）评估，帮助用户判断优先级",
  "- 审计过程中自动构建项目安全知识库，记录对各模块的分析",
  "- 用户可以设定审计关注面（如“聚焦认证逻辑”）和扫描时长",
  "- 扫描完成后可以继续深入，在已有发现基础上进一步探索",
  "- 平台支持生成专业安全审计报告，以及 POC 验证漏洞可利用性",
  "",
  "创建扫描任务时，逐步和用户确认项目来源、关注方向、扫描时长，信息齐备后再创建。与用户交流时用自然语言，不要出现英文参数名。",
  "",
  "创建扫描任务时，主动向用户说明并确认是否开启动态验证：能验证漏洞真实性、提升准确率，但会显著延长扫描时间；用户只说「扫一下」时默认不开。",
  "若开启动态验证时工具返回沙箱未部署的错误，如实告知用户该环境不支持动态验证。",
  "仅当用户明确要求「动态验证」「POC 验证」「漏洞利用」「开 EXP」等时，创建任务才设置 enable_dynamic_verify / enable_dynamic_exploit。",
  "",
  "扫描时长与项目代码规模相关，根据代码量估算：",
  "- 小型项目（几千行）：2-6 小时",
  "- 中型项目（几万行）：6-12 小时",
  "- 大型项目（十万行以上）：12 小时以上",
  "首次扫描可以先设较短时长查看初步结果，后续通过继续扫描逐步深入。估算时长前可以先了解项目规模。",
  "",
  "操作完成后，主动呈现相关内容帮助用户直观查看：",
  "查询到任务、漏洞、报告或知识库内容后，必须调用对应的呈现工具输出可交互卡片，用户点击卡片可以在右侧面板查看详情。不要用文字表格或 Markdown 列表代替卡片呈现。",
  "整理分析结论或生成自定义内容时，呈现为可预览的文件。",
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
const rpcCommands = new RpcCommandTracker((line) => writeToPi(line));

const credProviderMap = new Map<string, { providerKey: string; modelId: string }>();
const noAuthProxyTargets = new Map<string, string>();
const NO_AUTH_DUMMY_KEY = "vulnhunter-no-auth";

function getPiDir(): string {
  return join(process.env.HOME ?? "/root", ".pi", "agent");
}

function getMcpAdapterPath(): string {
  return process.env.PI_MCP_ADAPTER_PATH
    ?? join(getPiDir(), "npm", "node_modules", "pi-mcp-adapter");
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function noAuthProxyBaseUrl(targetKey: string): string {
  return `http://127.0.0.1:${PORT}/_llm_proxy/${encodeURIComponent(targetKey)}`;
}

function setupPiConfig(): void {
  const piDir = getPiDir();
  mkdirSync(piDir, { recursive: true });

  const providers: Record<string, unknown> = {};

  // Register primary credential
  if (BASE_URL) {
    const api = piApiForProtocol(MODEL_PROTO);
    if (!api) {
      console.error(`[bridge] Unknown MODEL_PROTO_TYPE: "${MODEL_PROTO}". Valid: ${SUPPORTED_MODEL_PROTOCOLS.join(", ")}`);
      process.exit(1);
    }
    const providerKey = "vulnhunter";
    const providerConfig: Record<string, unknown> = {
      baseUrl: API_KEY ? BASE_URL : noAuthProxyBaseUrl("primary"),
      api,
      // fish 2026-08-05: completions endpoints default to system role.
      models: [{
        id: MODEL_NAME, input: ["text", "image"], contextWindow: CONTEXT_WINDOW,
        // fish 2026-08-07: no maxTokens for OpenAI-compatible (kimi thinking-budget
        // 400); anthropic-messages keeps 36864 (API-required, budget 32768+4096).
        ...(api === "anthropic-messages" ? { maxTokens: 36_864 } : {}),
        ...(api === "openai-completions" ? { compat: { supportsDeveloperRole: false } } : {}),
      }],
    };
    process.env.VH_LLM_API_KEY = API_KEY || NO_AUTH_DUMMY_KEY;
    providerConfig.apiKey = "$VH_LLM_API_KEY";
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
        const api = piApiForProtocol(cred.proto_type);
        if (!api) continue;
        const providerKey = `va-${cred.id.slice(0, 8)}`;
        const apiKeyEnv = `VH_KEY_${cred.id.replace(/-/g, "_").slice(0, 12).toUpperCase()}`;

        // Skip if same provider already registered (primary credential)
        if (!providers[providerKey]) {
          const providerConfig: Record<string, unknown> = {
            baseUrl: cred.api_key ? cred.base_url : noAuthProxyBaseUrl(cred.id),
            api,
            models: [{
              id: cred.model_id, input: ["text", "image"], contextWindow: parsePositiveInt(String(cred.context_window_tokens ?? ""), DEFAULT_CONTEXT_WINDOW_TOKENS),
              ...(api === "anthropic-messages" ? { maxTokens: 36_864 } : {}),
              ...(api === "openai-completions" ? { compat: { supportsDeveloperRole: false } } : {}),
            }],
          };
          process.env[apiKeyEnv] = cred.api_key || NO_AUTH_DUMMY_KEY;
          providerConfig.apiKey = `$${apiKeyEnv}`;
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
        vulnhunter: {
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
    ? `vulnhunter/${MODEL_NAME}`
    : `${MODEL_PROTO}/${MODEL_NAME}`;

  const args = [
    "--mode", "rpc",
    "--model", modelStr,
    "--no-skills",
    "--no-extensions",
    "-e", getMcpAdapterPath(),
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

  const piDir = getPiDir();
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

    // Normalize pi tool events (toolCallId/toolName/result-object) into the
    // platform-agreed schema (tool_call_id/tool/result-string) before
    // broadcasting, so the frontend reducer and service persistence read a
    // single consistent shape. Non-tool events pass through unchanged.
    const outLine = normalizeToolEventLine(line);
    let event: unknown;
    try {
      event = JSON.parse(line);
      rpcCommands.accept(event);
    } catch {
      // Non-JSON output is still forwarded for diagnostics.
    }
    broadcastToClients(outLine);

    // Write to report events file for LiveLog
    if (reportEventsStream) {
      try {
        const parsed = JSON.parse(line);
        // Translate pi RPC events to service event format
        if (parsed.type === "tool_execution_start" || parsed.type === "tool_execution_end") {
          const evt = {
            timestamp: new Date().toISOString(),
            event: "tool_call",
            tool: parsed.toolName ?? parsed.tool_name ?? parsed.tool ?? parsed.name ?? "unknown",
            status: parsed.type === "tool_execution_end" ? ((parsed.error ?? parsed.isError) ? "error" : "success") : "running",
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
    rpcCommands.rejectAll(new Error(`pi exited with code ${code}`));
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

function writeToPi(line: string): boolean {
  if (!pi?.stdin || pi.stdin.destroyed) return false;
  lastActivity = Date.now();
  return pi.stdin.write(line);
}

function sendToPi(command: Record<string, unknown>): boolean {
  if (!writeToPi(`${JSON.stringify(command)}\n`)) {
    console.warn("[bridge] pi not running, cannot send command");
    return false;
  }
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
        ? `vulnhunter/${MODEL_NAME}`
        : `${MODEL_PROTO}/${MODEL_NAME}`;
    const piDir = getPiDir();
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
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      void handleSetModel(body, res);
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

/**
 * Batch 3 (fish 2026-08-08) + architect fix: model switch via pi reload RPC.
 *
 * Architect 2026-08-08 env-freeze fix: pi's child env is frozen at spawn.
 * We CANNOT set new env vars at runtime. Instead, we validate that the
 * $ENV_VAR referenced in models.json was already injected at startup
 * (via ALL_CREDENTIALS / primary credential). If not in the startup set,
 * reject with a clear message.
 *
 * Keyless credentials (noAuthProxy): the service sends apiKeyPresent=false;
 * the bridge rewrites baseUrl to the local _llm_proxy and points apiKey
 * at the NO_AUTH_DUMMY_KEY env (already set for keyless providers at startup).
 */
async function handleSetModel(body: string, res: ServerResponse): Promise<void> {
  let parsed: {
    credentialId?: string;
    modelsJson?: Record<string, unknown>;
    apiKeyEnvName?: string;
    apiKeyPresent?: boolean;
    providerKey?: string;
    modelId?: string;
  };
  try {
    parsed = JSON.parse(body);
  } catch {
    sendJson(res, 400, { ok: false, error: "Invalid JSON" });
    return;
  }

  if (!parsed.modelsJson || !parsed.providerKey || !parsed.modelId || !parsed.apiKeyEnvName) {
    sendJson(res, 400, { ok: false, error: "modelsJson, apiKeyEnvName, providerKey, modelId required" });
    return;
  }

  // Validate: the env var referenced in models.json MUST have been injected
  // at startup. If it's not in process.env, the credential wasn't in
  // ALL_CREDENTIALS — reject (new session needed).
  if (!(parsed.apiKeyEnvName in process.env)) {
    sendJson(res, 400, {
      ok: false,
      error: `Credential not in this session's switchable list (env ${parsed.apiKeyEnvName} not injected at startup). Start a new session to use it.`,
    });
    return;
  }

  try {
    let modelsToWrite = parsed.modelsJson;

    // Keyless credential: rewrite baseUrl to local proxy + point apiKey at dummy
    if (parsed.apiKeyPresent === false) {
      const proxyUrl = noAuthProxyBaseUrl(parsed.credentialId ?? "unknown");
      const dummyEnv = "VH_LLM_API_KEY"; // NO_AUTH_DUMMY_KEY is set here at startup
      // Deep-clone and patch the provider's baseUrl + apiKey
      modelsToWrite = JSON.parse(JSON.stringify(parsed.modelsJson));
      const providers = (modelsToWrite as any).providers;
      const platform = providers?.platform;
      if (platform) {
        platform.baseUrl = proxyUrl;
        platform.apiKey = `$${dummyEnv}`;
      }
      console.log(`[bridge] Keyless credential → proxy ${proxyUrl}`);
    }

    // 1. Rewrite models.json in piDir
    const piDir = getPiDir();
    writeFileSync(join(piDir, "models.json"), JSON.stringify(modelsToWrite, null, 2) + "\n");
    console.log(`[bridge] Rewrote models.json for credential=${parsed.credentialId ?? "unknown"} (env=$${parsed.apiKeyEnvName})`);

    // 2. Send reload RPC — pi re-reads models.json + resetApiProviders
    await rpcCommands.send({ type: "reload" });
    console.log("[bridge] reload confirmed → pi re-read models.json");

    // 3. Switch active model to the new provider/model
    await rpcCommands.send({ type: "set_model", provider: parsed.providerKey, modelId: parsed.modelId });
    console.log(`[bridge] set_model confirmed → provider=${parsed.providerKey}, model=${parsed.modelId}`);

    sendJson(res, 200, { ok: true, provider: parsed.providerKey, modelId: parsed.modelId });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.warn(`[bridge] set-model (reload path) failed: ${error}`);
    sendJson(res, 503, { ok: false, error });
  }
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
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
