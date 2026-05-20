import { randomUUID } from "node:crypto";
import { join } from "node:path";
import WebSocket from "ws";
import { createWorkerContainer, ensureWorkDir, getDocker, removeWorkDir } from "../workers/docker-client.js";
import { credentialToWorkerEnv } from "./credential-env.js";
import { runBasicChecks, type ModelDiagnosticInput, type ModelDiagnosticCheck } from "./model-diagnostics.js";
import type { DecryptedLlmCredential } from "./storage.js";
import type { ServiceConfig } from "../../infra/config.js";

export interface RuntimeDiagnosticResult {
  ok: boolean;
  summary: string;
  checks: ModelDiagnosticCheck[];
}

const PROMPT = "请调用平台工具列出当前任务，最多返回 1 条，然后用一句话回答验证结果。";

function check(id: string, label: string, status: ModelDiagnosticCheck["status"], message: string, detail?: string): ModelDiagnosticCheck {
  return { id, label, status, message, detail };
}

async function wait(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
  try { return await Promise.race([p, timeout]); } finally { if (timer) clearTimeout(timer); }
}

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  const res = await fetch(url, init);
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

async function getContainerUrl(containerId: string, network: string): Promise<string> {
  const info = await getDocker().getContainer(containerId).inspect();
  const ip = info.NetworkSettings.Networks?.[network]?.IPAddress || info.NetworkSettings.IPAddress;
  if (!ip) throw new Error("无法获取诊断 worker IP");
  return `http://${ip}:8080`;
}

async function waitHealth(baseUrl: string): Promise<void> {
  await withTimeout((async () => {
    while (true) {
      try {
        const h = await fetchJson(`${baseUrl}/health`);
        if (h?.ok && h?.pi_running) return;
      } catch { /* retry */ }
      await wait(500);
    }
  })(), 15_000, "诊断 worker/pi 启动超时");
}

async function runAgentSmoke(baseUrl: string): Promise<{ toolObserved: boolean; assistantObserved: boolean; detail: string }> {
  return withTimeout(new Promise((resolve, reject) => {
    let toolObserved = false;
    let assistantObserved = false;
    const seen: string[] = [];
    const ws = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/chat/events`);
    const finish = () => { try { ws.close(); } catch {} resolve({ toolObserved, assistantObserved, detail: seen.slice(-20).join("\n") }); };
    ws.on("open", async () => {
      try { await fetchJson(`${baseUrl}/chat/prompt`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: PROMPT }) }); }
      catch (err) { reject(err); }
    });
    ws.on("message", (buf) => {
      const line = String(buf);
      seen.push(line.slice(0, 500));
      try {
        const ev = JSON.parse(line) as Record<string, any>;
        const type = String(ev.type ?? "");
        const toolName = String(ev.tool_name ?? ev.name ?? ev.tool ?? "");
        if ((type === "tool_execution_start" || type === "tool_execution_end") && (toolName.includes("list") || toolName.includes("task") || toolName.includes("vulnhunt"))) toolObserved = true;
        if (type === "message_end" || type === "turn_end" || type === "response.completed") assistantObserved = true;
        if (toolObserved && assistantObserved) finish();
      } catch { /* ignore */ }
    });
    ws.on("error", reject);
  }), 60_000, "Agent 工具调用验证超时");
}

export async function diagnoseModelRuntimeCredential(cred: DecryptedLlmCredential, config: ServiceConfig): Promise<RuntimeDiagnosticResult> {
  const checks: ModelDiagnosticCheck[] = [];
  checks.push(check("config", "配置检查", "pass", "配置字段完整，凭证已解密。"));

  const input: ModelDiagnosticInput = { protoType: cred.proto_type, baseUrl: cred.base_url ?? "", modelId: cred.model_id, apiKey: cred.api_key, thinkingEffort: cred.thinking_effort };
  const preflight = await runBasicChecks(input);
  checks.push(...preflight.checks.filter((c) => c.id === "basic" || c.id === "stream"));
  const hard = checks.find((c) => c.status === "fail");
  if (hard) return { ok: false, summary: `${hard.label}失败：${hard.message}`, checks };

  const diagId = `diag-${randomUUID()}`;
  const hostWorkDir = join(config.dataDir, "diagnostics", diagId);
  let container: Awaited<ReturnType<typeof createWorkerContainer>> | undefined;
  try {
    ensureWorkDir(hostWorkDir);
    container = await createWorkerContainer({
      taskId: diagId,
      taskType: "chat",
      image: config.docker.workerImage,
      network: config.docker.network,
      hostWorkDir,
      autoRemove: false,
      cpuQuota: 100000,
      memoryBytes: 1024 * 1024 * 1024,
      env: {
        MODE: "chat",
        SESSION_ID: diagId,
        SESSION_DIR: "/workspace/chat-session",
        SERVICE_URL: `http://vulnhunt-service:${config.port}`,
        CHAT_WORKER_TOKEN: diagId,
        BRIDGE_PORT: "8080",
        IDLE_TIMEOUT_MIN: "2",
        ...credentialToWorkerEnv(cred),
      },
    });
    await container.start();
    checks.push(check("runtime", "启动运行时", "pass", "临时诊断 worker 已启动。"));
    const baseUrl = await getContainerUrl(container.id, config.docker.network);
    await waitHealth(baseUrl);
    checks.push(check("pi", "pi 初始化", "pass", "worker bridge 与 pi 已就绪。"));
    const smoke = await runAgentSmoke(baseUrl);
    checks.push(check("agent_tool", "Agent 工具调用", smoke.toolObserved && smoke.assistantObserved ? "pass" : "fail", smoke.toolObserved && smoke.assistantObserved ? "观察到 MCP 工具调用和最终回复。" : "未观察到完整 MCP 工具调用和最终回复。", smoke.detail));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    checks.push(check("runtime_error", "结果汇总", "fail", msg));
  } finally {
    if (container) { try { await container.remove({ force: true }); } catch {} }
    removeWorkDir(hostWorkDir);
  }
  const failed = checks.find((c) => c.status === "fail");
  checks.push(check("summary", "结果汇总", failed ? "fail" : "pass", failed ? "模型基础可能可用，但 Agent 运行时验证失败。" : "模型可用，Agent 运行时验证通过。"));
  return { ok: !failed, summary: failed ? "模型基础可能可用，但 Agent 运行时验证失败。" : "模型可用，Agent 运行时验证通过。", checks };
}
