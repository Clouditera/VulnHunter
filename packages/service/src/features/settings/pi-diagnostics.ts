/**
 * pi-native credential diagnostics — four-in-one CLI approach.
 *
 * Single `pi -p --mode json` CLI run, one event stream, four layer
 * assertions:
 *   L1 basic:     message_end assistant message contains non-empty text content
 *   L2 thinking:  when reasoning enabled, message contains thinking blocks
 *   L3 tool:      message_end contains read toolCall + turn_end has read toolResults
 *   L4 agent:     agent_settled reached with non-error assistant output
 *
 * This replaces the old L1-L3 process-internal streamSimple probes + separate
 * L4 CLI run. The test path now exactly matches the product path (same pi CLI,
 * same models.json), eliminating "probe path ≠ product path" divergence.
 *
 * Design: docs/vulnhunt-srv/architecture/unified-credential-models-json-v1.0.md §3.2
 *
 * SSE events are emitted for each layer matching the client contract:
 *   { type: "check_started|check_passed|check_failed|report", check: {...} }
 */

import type { DecryptedLlmCredential } from "./storage.js";
import { runCredentialCliCheck, type CredentialCliResult } from "./l4-agent-check.js";
import { PI_VERSION } from "@vulnhunter/shared";

// ── SSE event types (unchanged contract for client) ──────────────────

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

// ── Error formatting (unchanged) ─────────────────────────────────────

const RAW_ERROR_MAX = 200;

/**
 * fish 2026-08-06: failure rows show the RAW network error, nothing else.
 * Scrub the credential's plain API key from the string before it reaches
 * the UI. Truncate ~200 chars.
 */
export function formatRawError(error: string, httpStatus?: number, apiKey?: string): string {
  let msg = error;
  if (apiKey) msg = msg.split(apiKey).join("***");
  if (httpStatus && !/^HTTP \d{3}/.test(msg)) msg = `HTTP ${httpStatus} — ${msg}`;
  return msg.length > RAW_ERROR_MAX ? `${msg.slice(0, RAW_ERROR_MAX)}…` : msg;
}

// ── Event stream analysis ────────────────────────────────────────────

interface StreamAnalysis {
  /** L1: assistant message has non-empty text content */
  hasTextContent: boolean;
  /** L2: thinking/reasoning content blocks present */
  hasThinking: boolean;
  /** L3: read toolCall in message_end + read toolResult in turn_end */
  toolCallObserved: boolean;
  /** L4: agent_settled event reached */
  agentSettled: boolean;
  /** Error in any assistant message stopReason */
  hasError: boolean;
  /** Error message from upstream */
  errorMessage: string | null;
  /** Count of assistant messages */
  assistantMessageCount: number;
}

function analyzeEvents(events: unknown[]): StreamAnalysis {
  const assistantMessages = events.filter(
    (e) =>
      (e as { type?: string }).type === "message_end" &&
      (e as { message?: { role?: string } }).message?.role === "assistant",
  );

  const hasError = assistantMessages.some(
    (e) => (e as { message?: { stopReason?: string } }).message?.stopReason === "error",
  );

  const errMsgEvent = assistantMessages.find(
    (e) => (e as { message?: { errorMessage?: string } }).message?.errorMessage,
  );
  const errorMessage =
    (errMsgEvent as { message?: { errorMessage?: string } })?.message?.errorMessage ?? null;

  // L1: assistant message contains non-empty text content block
  const hasTextContent = assistantMessages.some((e) => {
    const content = (e as { message?: { content?: Array<{ type?: string }> } }).message?.content;
    return Array.isArray(content) && content.some((b) => b.type === "text");
  });

  // L2: thinking content blocks present
  const hasThinking = assistantMessages.some((e) => {
    const content = (e as { message?: { content?: Array<{ type?: string }> } }).message?.content;
    return Array.isArray(content) && content.some((b) => b.type === "thinking");
  });

  // L3: read tool call observed (fish 2026-08-08: bash → read for safety)
  const readToolCalls = events.filter((e) => {
    const ev = e as { type?: string; message?: { content?: Array<{ type?: string; name?: string }> } };
    return ev.type === "message_end" && Array.isArray(ev.message?.content)
      && ev.message!.content!.some((b) => b.type === "toolCall" && b.name === "read");
  });
  const readToolResults = events.filter((e) => {
    const ev = e as { type?: string; toolResults?: Array<{ toolName?: string; content?: unknown[] }> };
    return ev.type === "turn_end" && Array.isArray(ev.toolResults)
      && ev.toolResults!.some((r) => r.toolName === "read" && Array.isArray(r.content) && r.content.length > 0);
  });
  const toolCallObserved = readToolCalls.length > 0 && readToolResults.length > 0;

  // L4: agent settled
  const agentSettled = events.some(
    (e) => (e as { type?: string }).type === "agent_settled",
  );

  return {
    hasTextContent,
    hasThinking,
    toolCallObserved,
    agentSettled,
    hasError,
    errorMessage,
    assistantMessageCount: assistantMessages.length,
  };
}

// ── Main entry ───────────────────────────────────────────────────────

export interface PiDiagnosticResult {
  ok: boolean;
  checks: DiagnosticCheck[];
}

/**
 * Run four-layer credential diagnostics using a single pi CLI run.
 *
 * The CLI produces one JSONL event stream. All four layer assertions
 * (L1-L4) are derived from that same stream — "一跑四判" (one run, four
 * judgments).
 *
 * Each layer emits SSE events as it is evaluated; returns final result.
 */
export async function runPiDiagnostics(
  cred: DecryptedLlmCredential,
  emit: DiagnosticEmitter,
): Promise<PiDiagnosticResult> {
  const isReasoning =
    !!cred.thinking_effort &&
    cred.thinking_effort !== "off" &&
    cred.thinking_effort !== "none";

  // ── Run the CLI once ──
  const cliResult: CredentialCliResult = await runCredentialCliCheck({
    proto_type: cred.proto_type,
    base_url: cred.base_url,
    model_id: cred.model_id,
    thinking_effort: cred.thinking_effort,
    context_window_tokens: cred.context_window_tokens,
    api_key: cred.api_key,
    advanced_config: (cred as any).advanced_config ?? null,
  });

  const analysis = analyzeEvents(cliResult.events);
  const checks: DiagnosticCheck[] = [];

  // ── Derive error message for failure cases ──
  let failDetail: string;
  if (cliResult.timedOut) {
    failDetail = formatRawError(`timeout after ${120}s`);
  } else if (analysis.hasError && analysis.errorMessage) {
    failDetail = formatRawError(analysis.errorMessage, undefined, cred.api_key);
  } else if (cliResult.events.length === 0) {
    failDetail = cliResult.stderr.trim().slice(0, 300) || "pi CLI produced no output";
    failDetail = formatRawError(failDetail, undefined, cred.api_key);
  } else {
    failDetail = formatRawError(
      analysis.agentSettled
        ? "Agent completed but layer assertions failed"
        : "pi CLI did not reach agent_settled state",
      undefined, cred.api_key,
    );
  }

  // ── L1: Basic text ──
  {
    const id: DiagnosticCheckId = "basic";
    const passed = cliResult.events.length > 0 && analysis.hasTextContent && !cliResult.timedOut;
    const check: DiagnosticCheck = {
      id, label: "basic", layer: "L1",
      status: passed ? "pass" : "fail",
      message: passed ? "text_response_ok" : failDetail,
      durationMs: cliResult.durationMs,
      detail: passed ? undefined : failDetail,
    };
    emit({ type: "check_started", check: { ...check, status: "pass", message: "testing" } });
    emit({ type: passed ? "check_passed" : "check_failed", check });
    checks.push(check);
  }

  // L1 fail = immediate stop (no point evaluating other layers)
  if (checks[0].status === "fail") {
    emit({ type: "report", checks, ok: false });
    return { ok: false, checks };
  }

  // ── L2: Thinking ──
  {
    const id: DiagnosticCheckId = "thinking";
    if (!isReasoning) {
      const check: DiagnosticCheck = {
        id, label: "thinking", layer: "L2", status: "na", message: "not_reasoning",
      };
      emit({ type: "check_passed", check });
      checks.push(check);
    } else {
      const passed = analysis.hasThinking;
      const check: DiagnosticCheck = {
        id, label: "thinking", layer: "L2",
        status: passed ? "pass" : "fail",
        message: passed ? "thinking_confirmed" : "thinking_not_observed",
        durationMs: cliResult.durationMs,
        detail: passed ? undefined : "Reasoning was enabled but no thinking content blocks were observed in the response",
      };
      emit({ type: "check_started", check: { ...check, status: "pass", message: "testing" } });
      emit({ type: passed ? "check_passed" : "check_failed", check });
      checks.push(check);
    }
  }

  // ── L3: Tool calling ──
  {
    const id: DiagnosticCheckId = "tool";
    const passed = analysis.toolCallObserved;
    const check: DiagnosticCheck = {
      id, label: "tool", layer: "L3",
      status: passed ? "pass" : "fail",
      message: passed ? "tool_call_observed" : "tool_call_not_observed",
      durationMs: cliResult.durationMs,
      detail: passed ? undefined : "No clean read tool call was observed in the event stream",
    };
    emit({ type: "check_started", check: { ...check, status: "pass", message: "testing" } });
    emit({ type: passed ? "check_passed" : "check_failed", check });
    checks.push(check);
  }

  // ── L4: Agent circuit ──
  {
    const id: DiagnosticCheckId = "l4_agent";
    const passed = analysis.agentSettled && !analysis.hasError;
    const check: DiagnosticCheck = {
      id, label: "l4_agent", layer: "L4",
      status: passed ? "pass" : "fail",
      message: passed
        ? `agent_circuit_ok (pi ${PI_VERSION}, ${analysis.assistantMessageCount} assistant message(s))`
        : "agent_circuit_failed",
      durationMs: cliResult.durationMs,
      detail: passed ? undefined : failDetail,
    };
    emit({ type: "check_started", check: { ...check, status: "pass", message: "testing" } });
    emit({ type: passed ? "check_passed" : "check_failed", check });
    checks.push(check);
  }

  const ok = checks.every((c) => c.status === "pass" || c.status === "na");
  emit({ type: "report", checks, ok });
  return { ok, checks };
}
