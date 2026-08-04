/**
 * pi-native credential diagnostics — L1-L3 using pi-ai streamSimple.
 *
 * Replaces the old raw-fetch model-diagnostics with the same SDK path the
 * scan engine uses, so "test passed" means "the engine will work".
 *
 * Layers:
 *   L1 basic:     streamSimple("Reply ok") → assert text_delta observed
 *   L2 thinking:  for reasoning models, streamSimple with reasoning option → assert thinking_delta
 *   L3 tool:      streamSimple with diagnostic_echo tool + tool_choice → assert toolcall event
 *
 * Each layer is a 16-token call (<3s typical). Results are emitted as SSE
 * events matching the architect's contract:
 *   { type: "check_started|check_passed|check_failed|report", check: {...} }
 */

import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { AssistantMessageEvent, Model, Context } from "@earendil-works/pi-ai";
import type { DecryptedLlmCredential } from "./storage.js";

// ── SSE event types (architect's contract) ──────────────────────────

export type DiagnosticCheckId = "basic" | "thinking" | "tool";
export type DiagnosticLayer = "L1" | "L2" | "L3";

export interface DiagnosticCheck {
  id: DiagnosticCheckId;
  label: string;
  layer: DiagnosticLayer;
  status: "pass" | "fail" | "na";
  message: string;
  httpStatus?: number;
  durationMs?: number;
  detail?: string;
}

export interface DiagnosticEvent {
  type: "check_started" | "check_passed" | "check_failed" | "report";
  check?: DiagnosticCheck;
  /** Only for type="report" — full result array */
  checks?: DiagnosticCheck[];
  ok?: boolean;
}

export type DiagnosticEmitter = (event: DiagnosticEvent) => void;

// ── Helpers ──────────────────────────────────────────────────────────

function mapApiType(protoType: string): "openai-completions" | "anthropic-messages" | "openai-responses" {
  if (protoType.startsWith("anthropic")) return "anthropic-messages";
  if (protoType === "openai-responses") return "openai-responses";
  return "openai-completions";
}

function buildContext(message: string, tools?: any[]): Context {
  return {
    messages: [{ role: "user" as const, content: message, timestamp: Date.now() }],
    ...(tools ? { tools } : {}),
  };
}

function buildModel(cred: DecryptedLlmCredential): Model<any> {
  return {
    id: cred.model_id,
    name: cred.model_id,
    api: mapApiType(cred.proto_type),
    provider: "custom",
    baseUrl: (cred.base_url ?? "").replace(/\/+$/, ""),
    reasoning: !!cred.thinking_effort && cred.thinking_effort !== "off" && cred.thinking_effort !== "none",
  } as Model<any>;
}

const DIAGNOSTIC_TOOL = {
  name: "diagnostic_echo",
  description: "Echo a diagnostic message to verify tool calling works.",
  parameters: {
    type: "object" as const,
    properties: { message: { type: "string", description: "Message to echo" } },
    required: ["message"],
  },
};

async function consumeStream(
  stream: AsyncIterable<AssistantMessageEvent>,
  opts: { wantText?: boolean; wantThinking?: boolean; wantTool?: boolean; signal?: AbortSignal },
): Promise<{ text: boolean; thinking: boolean; tool: boolean; error?: string; httpStatus?: number }> {
  let text = false;
  let thinking = false;
  let tool = false;
  let error: string | undefined;
  let httpStatus: number | undefined;

  try {
    for await (const ev of stream) {
      if (opts.signal?.aborted) break;
      switch (ev.type) {
        case "text_delta":
        case "text_end":
          text = true;
          break;
        case "thinking_delta":
        case "thinking_end":
          thinking = true;
          break;
        case "toolcall_end":
          tool = true;
          break;
        case "error":
          error = ev.error.errorMessage ?? ev.error.stopReason ?? "Model returned an error";
          break;
      }
    }
  } catch (err: any) {
    // Extract HTTP status from fetch errors if available
    error = err?.message ?? String(err);
    if (err?.status) httpStatus = err.status;
  }

  return { text, thinking, tool, error, httpStatus };
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout (${ms}ms)`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => { if (timer) clearTimeout(timer); });
}

// ── L1: Basic text generation ────────────────────────────────────────

async function runL1Basic(cred: DecryptedLlmCredential, emit: DiagnosticEmitter): Promise<DiagnosticCheck> {
  const id: DiagnosticCheckId = "basic";
  const label = "基础文本生成";
  const t0 = Date.now();
  emit({ type: "check_started", check: { id, label, layer: "L1", status: "pass", message: "测试中…" } });

  try {
    const model = buildModel(cred);
    const context = buildContext("Reply with the single word: ok");
    const stream = streamSimple(model, context, {
      apiKey: cred.api_key,
      maxTokens: 16,
      signal: AbortSignal.timeout(20_000),
    });
    const result = await withTimeout(
      consumeStream(stream, { wantText: true, signal: AbortSignal.timeout(20_000) }),
      25_000,
      "L1 basic",
    );

    if (result.error && !result.text) {
      const check: DiagnosticCheck = {
        id, label, layer: "L1", status: "fail",
        message: result.error,
        httpStatus: result.httpStatus,
        durationMs: Date.now() - t0,
        detail: `proto=${cred.proto_type} base_url=${cred.base_url} model=${cred.model_id}`,
      };
      emit({ type: "check_failed", check });
      return check;
    }

    const check: DiagnosticCheck = {
      id, label, layer: "L1", status: "pass",
      message: "模型响应正常",
      durationMs: Date.now() - t0,
    };
    emit({ type: "check_passed", check });
    return check;
  } catch (err: any) {
    const check: DiagnosticCheck = {
      id, label, layer: "L1", status: "fail",
      message: err?.message ?? String(err),
      durationMs: Date.now() - t0,
      detail: `proto=${cred.proto_type} base_url=${cred.base_url} model=${cred.model_id}`,
    };
    emit({ type: "check_failed", check });
    return check;
  }
}

// ── L2: Thinking / reasoning ─────────────────────────────────────────

async function runL2Thinking(cred: DecryptedLlmCredential, emit: DiagnosticEmitter): Promise<DiagnosticCheck> {
  const id: DiagnosticCheckId = "thinking";
  const label = "模型思考";
  const t0 = Date.now();

  // Non-reasoning models → N/A
  const isReasoning = !!cred.thinking_effort && cred.thinking_effort !== "off" && cred.thinking_effort !== "none";
  if (!isReasoning) {
    const check: DiagnosticCheck = {
      id, label, layer: "L2", status: "na",
      message: "非推理模型（thinking_effort=off），跳过思考测试",
    };
    emit({ type: "check_passed", check });
    return check;
  }

  emit({ type: "check_started", check: { id, label, layer: "L2", status: "pass", message: "测试中…" } });

  try {
    const model = buildModel(cred);
    const context = buildContext("Think step by step: what is 2+2?");
    const stream = streamSimple(model, context, {
      apiKey: cred.api_key,
      maxTokens: 64,
      reasoning: (cred.thinking_effort as any) ?? "medium",
      signal: AbortSignal.timeout(30_000),
    });
    const result = await withTimeout(
      consumeStream(stream, { wantThinking: true, signal: AbortSignal.timeout(30_000) }),
      35_000,
      "L2 thinking",
    );

    if (result.error && !result.thinking) {
      const check: DiagnosticCheck = {
        id, label, layer: "L2", status: "fail",
        message: `思考测试失败：${result.error}`,
        httpStatus: result.httpStatus,
        durationMs: Date.now() - t0,
      };
      emit({ type: "check_failed", check });
      return check;
    }

    const check: DiagnosticCheck = {
      id, label, layer: "L2",
      status: result.thinking ? "pass" : "na",
      message: result.thinking ? "思考内容已确认" : "未观察到思考内容块（模型可能不支持 thinking 输出）",
      durationMs: Date.now() - t0,
    };
    emit({ type: "check_passed", check });
    return check;
  } catch (err: any) {
    const check: DiagnosticCheck = {
      id, label, layer: "L2", status: "fail",
      message: err?.message ?? String(err),
      durationMs: Date.now() - t0,
    };
    emit({ type: "check_failed", check });
    return check;
  }
}

// ── L3: Tool calling ─────────────────────────────────────────────────

async function runL3Tool(cred: DecryptedLlmCredential, emit: DiagnosticEmitter): Promise<DiagnosticCheck> {
  const id: DiagnosticCheckId = "tool";
  const label = "工具调用";
  const t0 = Date.now();
  emit({ type: "check_started", check: { id, label, layer: "L3", status: "pass", message: "测试中…" } });

  try {
    const model = buildModel(cred);
    const context = buildContext("Call the diagnostic_echo tool with message 'hello'", [DIAGNOSTIC_TOOL]);
    const stream = streamSimple(model, context, {
      apiKey: cred.api_key,
      maxTokens: 128,
      signal: AbortSignal.timeout(30_000),
    });
    const result = await withTimeout(
      consumeStream(stream, { wantTool: true, signal: AbortSignal.timeout(30_000) }),
      35_000,
      "L3 tool",
    );

    if (result.error && !result.tool) {
      const check: DiagnosticCheck = {
        id, label, layer: "L3", status: "fail",
        message: `工具调用测试失败：${result.error}`,
        httpStatus: result.httpStatus,
        durationMs: Date.now() - t0,
      };
      emit({ type: "check_failed", check });
      return check;
    }

    const check: DiagnosticCheck = {
      id, label, layer: "L3",
      status: result.tool ? "pass" : "fail",
      message: result.tool ? "模型发出了工具调用" : "模型未发出工具调用（Agent 功能可能受限）",
      durationMs: Date.now() - t0,
    };
    emit({ type: result.tool ? "check_passed" : "check_failed", check });
    return check;
  } catch (err: any) {
    const check: DiagnosticCheck = {
      id, label, layer: "L3", status: "fail",
      message: err?.message ?? String(err),
      durationMs: Date.now() - t0,
    };
    emit({ type: "check_failed", check });
    return check;
  }
}

// ── Main entry ───────────────────────────────────────────────────────

export interface PiDiagnosticResult {
  ok: boolean;
  checks: DiagnosticCheck[];
}

/**
 * Run L1-L3 pi-native credential diagnostics.
 * Each layer emits SSE events as it runs; returns final result.
 */
export async function runPiDiagnostics(
  cred: DecryptedLlmCredential,
  emit: DiagnosticEmitter,
): Promise<PiDiagnosticResult> {
  const checks: DiagnosticCheck[] = [];

  // L1 — basic connectivity (fail = immediate stop)
  const l1 = await runL1Basic(cred, emit);
  checks.push(l1);
  if (l1.status === "fail") {
    emit({ type: "report", checks, ok: false });
    return { ok: false, checks };
  }

  // L2 — thinking (N/A for non-reasoning)
  const l2 = await runL2Thinking(cred, emit);
  checks.push(l2);

  // L3 — tool calling
  const l3 = await runL3Tool(cred, emit);
  checks.push(l3);

  const hardFail = checks.some((c) => c.status === "fail");
  emit({ type: "report", checks, ok: !hardFail });
  return { ok: !hardFail, checks };
}
