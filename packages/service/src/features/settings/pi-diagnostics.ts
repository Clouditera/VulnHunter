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

export type DiagnosticCheckId = "basic" | "thinking" | "tool" | "l4_agent";
export type DiagnosticLayer = "L1" | "L2" | "L3" | "L4";

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
  const api = mapApiType(cred.proto_type);
  return {
    id: cred.model_id,
    name: cred.model_id,
    api,
    provider: "custom",
    baseUrl: (cred.base_url ?? "").replace(/\/+$/, ""),
    reasoning: !!cred.thinking_effort && cred.thinking_effort !== "off" && cred.thinking_effort !== "none",
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    contextWindow: cred.context_window_tokens ?? 128000,
    // fish 2026-08-06: NO maxTokens for OpenAI-compatible APIs — a
    // self-imposed output cap leaks into the real request and collides with
    // gateway thinking budgets (kimi mid-tier: 64/16384 < thinking_budget
    // 32768 → 400). Without the field the gateway applies the model's own
    // default max output, compatible with its own budget mapping.
    // Anthropic /messages REQUIRES max_tokens (API contract; pi-ai derives
    // NaN/null without it) — give thinking budget (32768) + 4096 margin.
    ...(api === "anthropic-messages" ? { maxTokens: 36_864 } : {}),
    // fish 2026-08-05: completions endpoints default to system role — the
    // TEST path must match the real-task generation shape (test/run seam).
    ...(api === "openai-completions" ? { compat: { supportsDeveloperRole: false } } : {}),
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

const RAW_ERROR_MAX = 200;

/**
 * fish 2026-08-06: L1-L4 all share one 120s timeout budget. No layer may
 * run unbounded — a hung upstream must surface as a fail, not a spinner.
 */
const DIAGNOSTIC_TIMEOUT_MS = 120_000;

/**
 * fish 2026-08-06: failure rows show the RAW network error, nothing else.
 * Compose HTTP status + gateway body when a status is present (service
 * reachable), else the transport cause verbatim (ENOTFOUND / ECONNREFUSED /
 * timeout). Safety gate: scrub the credential's plain API key from the
 * string before it reaches the UI (some gateways echo it back; their own
 * masking is not to be relied on). Truncate ~200 chars.
 */
export function formatRawError(error: string, httpStatus?: number, apiKey?: string): string {
  let msg = error;
  if (apiKey) msg = msg.split(apiKey).join("***");
  if (httpStatus && !/^HTTP \d{3}/.test(msg)) msg = `HTTP ${httpStatus} — ${msg}`;
  return msg.length > RAW_ERROR_MAX ? `${msg.slice(0, RAW_ERROR_MAX)}…` : msg;
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
  const label = "basic";
  const t0 = Date.now();
  emit({ type: "check_started", check: { id, label, layer: "L1", status: "pass", message: "testing" } });

  // Direct fetch instead of a pi-ai stream (QA-proven 2026-08-06): pi-ai 0.83
  // swallows network errors into a generic errorMessage ("Connection error." /
  // "Cannot read properties of undefined") — errno, HTTP status and gateway
  // body never surface. undici gives us everything fish wants: err.cause.code
  // (ENOTFOUND/ECONNREFUSED) and HTTP status + response body for non-2xx.
  // The request body carries the model, so "model not exist" surfaces HERE as
  // HTTP 400 with the gateway's own message.
  try {
    const api = mapApiType(cred.proto_type);
    const baseUrl = (cred.base_url ?? "").replace(/\/+$/, "");
    // Mirror pi-ai: paths are appended to the user's base URL (which is
    // expected to include /v1 when the gateway requires it).
    const path = api === "anthropic-messages" ? "/messages" : api === "openai-responses" ? "/responses" : "/chat/completions";
    const body = api === "anthropic-messages"
      // Anthropic /messages REQUIRES max_tokens (API contract). Give the
      // thinking budget (32768) + 4096 margin — architect 2026-08-06. The
      // OpenAI-compatible branches carry NO max field: the gateway applies
      // its model default (kimi thinking-budget regression fix).
      ? { model: cred.model_id, max_tokens: 36_864, messages: [{ role: "user", content: "Reply with the single word: ok" }] }
      : api === "openai-responses"
        ? { model: cred.model_id, input: "Reply with the single word: ok" }
        : { model: cred.model_id, messages: [{ role: "user", content: "Reply with the single word: ok" }] };

    // Anthropic contract: x-api-key + anthropic-version (Bearer 401s);
    // OpenAI-compatible endpoints: Bearer. Mirrors the real gateways.
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (api === "anthropic-messages") {
      headers["x-api-key"] = cred.api_key;
      headers["anthropic-version"] = "2023-06-01";
    } else {
      headers["Authorization"] = `Bearer ${cred.api_key}`;
    }

    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DIAGNOSTIC_TIMEOUT_MS),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const check: DiagnosticCheck = {
        id, label, layer: "L1", status: "fail",
        message: formatRawError(text.trim().slice(0, 200) || `HTTP ${res.status}`, res.status, cred.api_key),
        httpStatus: res.status,
        durationMs: Date.now() - t0,
      };
      emit({ type: "check_failed", check });
      return check;
    }

    const check: DiagnosticCheck = {
      id, label, layer: "L1", status: "pass",
      message: "model_responded",
      durationMs: Date.now() - t0,
    };
    emit({ type: "check_passed", check });
    return check;
  } catch (err: any) {
    // undici network errors: errno on err.cause (fetch failed → cause).
    const cause = err?.cause as { code?: string; message?: string } | undefined;
    const raw = cause?.code
      ? `${cause.code}${cause.message ? ` ${cause.message}` : ""}`
      : (err?.message ?? String(err));
    const check: DiagnosticCheck = {
      id, label, layer: "L1", status: "fail",
      message: formatRawError(raw, err?.status, cred.api_key),
      durationMs: Date.now() - t0,
    };
    emit({ type: "check_failed", check });
    return check;
  }
}

// ── L2: Thinking / reasoning ─────────────────────────────────────────

async function runL2Thinking(cred: DecryptedLlmCredential, emit: DiagnosticEmitter): Promise<DiagnosticCheck> {
  const id: DiagnosticCheckId = "thinking";
  const label = "thinking";
  const t0 = Date.now();

  // Non-reasoning models → N/A
  const isReasoning = !!cred.thinking_effort && cred.thinking_effort !== "off" && cred.thinking_effort !== "none";
  if (!isReasoning) {
    const check: DiagnosticCheck = {
      id, label, layer: "L2", status: "na",
      message: "not_reasoning",
    };
    emit({ type: "check_passed", check });
    return check;
  }

  emit({ type: "check_started", check: { id, label, layer: "L2", status: "pass", message: "testing" } });

  try {
    const model = buildModel(cred);
    const context = buildContext("Think step by step: what is 2+2?");
    const stream = streamSimple(model, context, {
      apiKey: cred.api_key,
      // fish 2026-08-06: no maxTokens (see buildModel) — the probe must not
      // self-limit output in a way that collides with gateway budgets.
      reasoning: (cred.thinking_effort as any) ?? "medium",
      signal: AbortSignal.timeout(DIAGNOSTIC_TIMEOUT_MS),
    });
    const result = await withTimeout(
      consumeStream(stream, { wantThinking: true, signal: AbortSignal.timeout(DIAGNOSTIC_TIMEOUT_MS) }),
      DIAGNOSTIC_TIMEOUT_MS,
      "L2 thinking",
    );

    if (result.error && !result.thinking) {
      const check: DiagnosticCheck = {
        id, label, layer: "L2", status: "fail",
        message: formatRawError(result.error, result.httpStatus, cred.api_key),
        httpStatus: result.httpStatus,
        durationMs: Date.now() - t0,
      };
      emit({ type: "check_failed", check });
      return check;
    }

    const check: DiagnosticCheck = {
      id, label, layer: "L2",
      status: result.thinking ? "pass" : "na",
      message: result.thinking ? "thinking_confirmed" : "thinking_not_observed",
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
  const label = "tool";
  const t0 = Date.now();
  emit({ type: "check_started", check: { id, label, layer: "L3", status: "pass", message: "testing" } });

  try {
    const model = buildModel(cred);
    const context = buildContext("Call the diagnostic_echo tool with message 'hello'", [DIAGNOSTIC_TOOL]);
    const stream = streamSimple(model, context, {
      apiKey: cred.api_key,
      // fish 2026-08-06: no maxTokens (see buildModel).
      signal: AbortSignal.timeout(DIAGNOSTIC_TIMEOUT_MS),
    });
    const result = await withTimeout(
      consumeStream(stream, { wantTool: true, signal: AbortSignal.timeout(DIAGNOSTIC_TIMEOUT_MS) }),
      DIAGNOSTIC_TIMEOUT_MS,
      "L3 tool",
    );

    if (result.error && !result.tool) {
      const check: DiagnosticCheck = {
        id, label, layer: "L3", status: "fail",
        message: formatRawError(result.error, result.httpStatus, cred.api_key),
        httpStatus: result.httpStatus,
        durationMs: Date.now() - t0,
      };
      emit({ type: "check_failed", check });
      return check;
    }

    const check: DiagnosticCheck = {
      id, label, layer: "L3",
      status: result.tool ? "pass" : "fail",
      message: result.tool ? "tool_call_observed" : "tool_call_not_observed",
      durationMs: Date.now() - t0,
    };
    emit({ type: result.tool ? "check_passed" : "check_failed", check });
    return check;
  } catch (err: any) {
    const check: DiagnosticCheck = {
      id, label, layer: "L3", status: "fail",
      message: formatRawError(err?.message ?? String(err), err?.status, cred.api_key),
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
