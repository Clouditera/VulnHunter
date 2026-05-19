export interface ModelDiagnosticInput {
  protoType: string;
  baseUrl: string;
  modelId: string;
  apiKey: string;
  thinkingEffort?: string;
}

export type ModelDiagnosticCategory = "config" | "network" | "auth" | "model" | "format" | "stream" | "tool_call" | "timeout" | "reasoning";
export interface ModelDiagnosticCheck {
  id: string;
  label: string;
  status: "pass" | "fail" | "warn" | "skip";
  category?: ModelDiagnosticCategory;
  message: string;
  detail?: string;
  suggestion?: string;
  httpStatus?: number;
  endpoint?: string;
  durationMs?: number;
}
export interface ModelDiagnosticResult {
  ok: boolean;
  summary: string;
  checks: ModelDiagnosticCheck[];
}

type Req = { endpoint: string; headers: Record<string, string>; body: Record<string, unknown> };
const OPENAI_DEFAULT = "https://api.openai.com/v1";
const ANTHROPIC_DEFAULT = "https://api.anthropic.com/v1";
const TOOL = { type: "function", function: { name: "diagnostic_echo", description: "echo diagnostic", parameters: { type: "object", properties: { message: { type: "string" } }, required: ["message"] } } };
const RESP_TOOL = { type: "function", name: "diagnostic_echo", description: "echo diagnostic", parameters: { type: "object", properties: { message: { type: "string" } }, required: ["message"] } };
const ANTH_TOOL = { name: "diagnostic_echo", description: "echo diagnostic", input_schema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] } };

function cleanBase(input: ModelDiagnosticInput) { return (input.baseUrl || (input.protoType === "anthropic" ? ANTHROPIC_DEFAULT : OPENAI_DEFAULT)).replace(/\/$/, ""); }
function snippet(s: string) { return s.replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]").slice(0, 2000); }
function now() { return Date.now(); }
function isReasoningOn(v?: string) { return !!v && v !== "off" && v !== "none"; }
function reasoningPayload(input: ModelDiagnosticInput) { return isReasoningOn(input.thinkingEffort) ? { reasoning_effort: input.thinkingEffort } : {}; }

function classify(status: number | undefined, text: string, fallback: ModelDiagnosticCategory): Pick<ModelDiagnosticCheck, "category" | "suggestion"> {
  const lower = text.toLowerCase();
  if (status === 401 || status === 403) return { category: "auth", suggestion: "检查 API Key、鉴权 Header 与服务端授权配置。" };
  if (status === 404) return { category: "config", suggestion: "检查 Base URL 是否多/少了 /v1，或协议类型是否选择错误。" };
  if (lower.includes("model") && (lower.includes("not found") || lower.includes("does not exist") || lower.includes("unknown"))) return { category: "model", suggestion: "检查模型 ID，或先点击获取模型列表确认服务端可用模型。" };
  if (lower.includes("tool") || lower.includes("tool_choice") || lower.includes("function")) return { category: "tool_call", suggestion: "该模型端点可能不支持工具调用，Chat/扫描 Agent 可能不可用。" };
  if (lower.includes("reasoning") || lower.includes("thinking")) return { category: "reasoning", suggestion: "关闭 thinking/reasoning，或调整模型服务启动参数以兼容 reasoning 字段。" };
  if (lower.includes("stream")) return { category: "stream", suggestion: "检查模型服务或代理是否支持 SSE streaming。" };
  return { category: fallback, suggestion: fallback === "network" ? "检查 Base URL、端口、防火墙、TLS/反向代理配置。" : undefined };
}

async function post(req: Req, timeoutMs: number): Promise<{ ok: boolean; status: number; text: string; durationMs: number; contentType: string }> {
  const t0 = now();
  const res = await fetch(req.endpoint, { method: "POST", headers: req.headers, body: JSON.stringify(req.body), signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text().catch(() => "");
  return { ok: res.ok, status: res.status, text, durationMs: now() - t0, contentType: res.headers.get("content-type") ?? "" };
}

function makeReq(input: ModelDiagnosticInput, kind: "basic" | "stream" | "tool"): Req {
  const base = cleanBase(input);
  if (input.protoType === "anthropic") {
    const body: Record<string, unknown> = { model: input.modelId, max_tokens: 16, messages: [{ role: "user", content: kind === "tool" ? "Call diagnostic_echo with message ok" : "Reply ok" }] };
    if (kind === "stream") body.stream = true;
    if (kind === "tool") { body.tools = [ANTH_TOOL]; body.tool_choice = { type: "tool", name: "diagnostic_echo" }; }
    return { endpoint: `${base}/messages`, headers: { "Content-Type": "application/json", "x-api-key": input.apiKey, "anthropic-version": "2023-06-01" }, body };
  }
  if (input.protoType === "openai-responses") {
    const body: Record<string, unknown> = { model: input.modelId, max_output_tokens: 16, input: kind === "tool" ? "Call diagnostic_echo with message ok" : "Reply ok", ...reasoningPayload(input) };
    if (kind === "stream") body.stream = true;
    if (kind === "tool") body.tools = [RESP_TOOL];
    return { endpoint: `${base}/responses`, headers: { "Content-Type": "application/json", Authorization: `Bearer ${input.apiKey}` }, body };
  }
  const body: Record<string, unknown> = { model: input.modelId, max_tokens: 16, messages: [{ role: "user", content: kind === "tool" ? "Call diagnostic_echo with message ok" : "Reply ok" }], ...reasoningPayload(input) };
  if (kind === "stream") body.stream = true;
  if (kind === "tool") { body.tools = [TOOL]; body.tool_choice = { type: "function", function: { name: "diagnostic_echo" } }; }
  return { endpoint: `${base}/chat/completions`, headers: { "Content-Type": "application/json", Authorization: `Bearer ${input.apiKey}` }, body };
}

function pass(id: string, label: string, message: string, endpoint?: string, durationMs?: number): ModelDiagnosticCheck { return { id, label, status: "pass", message, endpoint, durationMs }; }
function fail(id: string, label: string, category: ModelDiagnosticCategory, message: string, req: Req | undefined, detail?: string, httpStatus?: number, durationMs?: number, suggestion?: string): ModelDiagnosticCheck { return { id, label, status: "fail", category, message, endpoint: req?.endpoint, detail: detail ? snippet(detail) : undefined, httpStatus, durationMs, suggestion }; }

async function runCheck(input: ModelDiagnosticInput, id: "basic" | "stream" | "tool", label: string, timeout: number): Promise<ModelDiagnosticCheck> {
  const req = makeReq(input, id);
  try {
    const r = await post(req, timeout);
    if (!r.ok) {
      const c = classify(r.status, r.text, id === "stream" ? "stream" : id === "tool" ? "tool_call" : "format");
      return fail(id, label, c.category!, `HTTP ${r.status}`, req, r.text, r.status, r.durationMs, c.suggestion);
    }
    if (id === "stream" && !r.text.includes("data:") && !r.contentType.includes("event-stream")) return fail(id, label, "stream", "响应不是 SSE streaming 格式", req, r.text, r.status, r.durationMs, "检查模型服务或代理是否启用了 streaming/SSE。");
    if (id === "tool" && !/tool|function_call|tool_use|function_call/i.test(r.text)) return { ...pass(id, label, "基础请求成功，但未观察到工具调用对象。", req.endpoint, r.durationMs), status: "warn", category: "tool_call", suggestion: "如果 Chat/扫描需要 Agent 工具调用，请确认模型支持 tools/tool_choice。", detail: snippet(r.text) };
    return pass(id, label, "通过", req.endpoint, r.durationMs);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const cat: ModelDiagnosticCategory = msg.includes("timeout") || msg.includes("aborted") ? "timeout" : "network";
    const c = classify(undefined, msg, cat);
    return fail(id, label, c.category!, msg, req, msg, undefined, undefined, c.suggestion ?? (cat === "timeout" ? "检查模型服务并发、启动参数或响应耗时。" : undefined));
  }
}

export async function diagnoseModelCredential(input: ModelDiagnosticInput): Promise<ModelDiagnosticResult> {
  const checks: ModelDiagnosticCheck[] = [];
  const proto = input.protoType || "openai-completions";
  if (!input.modelId || !input.apiKey) checks.push({ id: "config", label: "配置检查", status: "fail", category: "config", message: "model_id/api_key 必填", suggestion: "填写模型 ID 和 API Key，或选择已保存凭证。" });
  else if (!["openai-completions", "openai", "openai-responses", "anthropic"].includes(proto)) checks.push({ id: "config", label: "配置检查", status: "warn", category: "config", message: `未知协议 ${proto}，按 OpenAI Chat Completions 兼容模式测试。` });
  else checks.push({ id: "config", label: "配置检查", status: "pass", message: "配置字段完整。" });
  if (checks.some((c) => c.status === "fail")) return { ok: false, summary: "模型配置不完整。", checks };
  const normalized = { ...input, protoType: proto === "openai" ? "openai-completions" : proto };
  const basic = await runCheck(normalized, "basic", "基础文本生成", 15000); checks.push(basic);
  if (basic.status === "fail") return { ok: false, summary: `基础连通失败：${basic.message}`, checks };
  checks.push(await runCheck(normalized, "stream", "Streaming 响应", 20000));
  checks.push(await runCheck(normalized, "tool", "工具调用兼容", 25000));
  if (isReasoningOn(input.thinkingEffort)) {
    const failed = checks.find((c) => c.category === "reasoning" && c.status === "fail");
    checks.push({ id: "reasoning", label: "Reasoning 参数兼容", status: failed ? "fail" : "pass", category: failed ? "reasoning" : undefined, message: failed ? "reasoning/thinking 参数不兼容。" : "未观察到 reasoning 参数错误。", suggestion: failed ? "关闭 thinking mode 或调整模型服务 reasoning 参数。" : undefined });
  }
  const hardFail = checks.find((c) => c.status === "fail");
  const warn = checks.find((c) => c.status === "warn");
  return { ok: !hardFail, summary: hardFail ? `模型基础可用性存在问题：${hardFail.label} 失败。` : warn ? "基础连通成功，但部分能力可能影响 Chat/扫描。" : "模型诊断通过，基础生成、streaming 和工具调用可用。", checks };
}
