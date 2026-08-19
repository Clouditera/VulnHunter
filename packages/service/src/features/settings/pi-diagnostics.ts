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
  status: "pass" | "fail" | "na" | "warn";
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
  /** Only for type="report" — human summary for the panel */
  summary?: string;
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

// ── Progressive stream tracker ───────────────────────────────────────
// fish/architect 2026-08-09: emit layer passes as positive evidence arrives
// mid-stream (text → L1, thinking → L2, read tool → L3, settled → L4),
// restoring progressive UI after the one-run-four-judgments merge.

interface ProgressiveState {
  l1: boolean;
  l2: boolean;
  l3Call: boolean;
  l3Result: boolean;
  l4: boolean;
  hasError: boolean;
  errorMessage: string | null;
  assistantMessageCount: number;
  /** Layer ids already emitted as pass (avoid double-emit). */
  emitted: Set<DiagnosticCheckId>;
}

function contentBlocks(ev: unknown): Array<{ type?: string; name?: string }> {
  const content = (ev as { message?: { content?: Array<{ type?: string; name?: string }> } })
    .message?.content;
  return Array.isArray(content) ? content : [];
}

function hasBlock(ev: unknown, type: string): boolean {
  return contentBlocks(ev).some((b) => b.type === type);
}

/**
 * Feed one pi JSONL event into progressive state and emit check_passed
 * the first time each layer's positive evidence appears.
 */
function feedProgressiveEvent(
  state: ProgressiveState,
  ev: unknown,
  emit: DiagnosticEmitter,
  opts: { isReasoning: boolean; t0: number },
): void {
  const type = (ev as { type?: string }).type;
  const elapsed = () => Date.now() - opts.t0;

  const passOnce = (id: DiagnosticCheckId, layer: DiagnosticLayer, message: string) => {
    if (state.emitted.has(id)) return;
    state.emitted.add(id);
    const check: DiagnosticCheck = {
      id, label: id, layer, status: "pass", message, durationMs: elapsed(),
    };
    emit({ type: "check_passed", check });
  };

  // Streaming deltas (pi-ai stream events inside message)
  if (type === "message_update" || type === "message_delta") {
    const assistantEvent = (ev as { assistantMessageEvent?: { type?: string } }).assistantMessageEvent
      ?? (ev as { event?: { type?: string } }).event;
    const deltaType = assistantEvent?.type;
    if (deltaType === "text_delta" || deltaType === "text_start" || deltaType === "text_end") {
      state.l1 = true;
      passOnce("basic", "L1", "text_response_ok");
    }
    if (deltaType === "thinking_delta" || deltaType === "thinking_start" || deltaType === "thinking_end") {
      state.l2 = true;
      if (opts.isReasoning) passOnce("thinking", "L2", "thinking_confirmed");
    }
  }

  if (type === "message_end") {
    const role = (ev as { message?: { role?: string } }).message?.role;
    if (role === "assistant") {
      state.assistantMessageCount++;
      const stopReason = (ev as { message?: { stopReason?: string } }).message?.stopReason;
      if (stopReason === "error") {
        state.hasError = true;
        const errMsg = (ev as { message?: { errorMessage?: string } }).message?.errorMessage;
        if (errMsg) state.errorMessage = errMsg;
      }
      if (hasBlock(ev, "text")) {
        state.l1 = true;
        passOnce("basic", "L1", "text_response_ok");
      }
      if (hasBlock(ev, "thinking")) {
        state.l2 = true;
        if (opts.isReasoning) passOnce("thinking", "L2", "thinking_confirmed");
      }
      if (contentBlocks(ev).some((b) => b.type === "toolCall" && b.name === "read")) {
        state.l3Call = true;
      }
    }
  }

  if (type === "turn_end") {
    const results = (ev as { toolResults?: Array<{ toolName?: string; content?: unknown[]; isError?: boolean }> }).toolResults;
    if (Array.isArray(results)) {
      const okRead = results.some(
        (r) => r.toolName === "read" && Array.isArray(r.content) && r.content.length > 0 && !r.isError,
      );
      if (okRead) {
        state.l3Result = true;
        if (state.l3Call) passOnce("tool", "L3", "tool_call_observed");
      }
    }
  }

  if (type === "agent_settled") {
    state.l4 = true;
    // L4 pass deferred to finalization (need !hasError confirmed at end)
  }
}

// ── Main entry ───────────────────────────────────────────────────────

export interface PiDiagnosticResult {
  ok: boolean;
  checks: DiagnosticCheck[];
  summary?: string;
}

/**
 * Run four-layer credential diagnostics using a single pi CLI run.
 *
 * Progressive emit (fish 2026-08-09): positive evidence for each layer is
 * emitted as soon as it appears in the live event stream, so the UI lights
 * up L1→L2→L3→L4 one by one. Failures are finalized at process end/timeout.
 */
export async function runPiDiagnostics(
  cred: DecryptedLlmCredential,
  emit: DiagnosticEmitter,
): Promise<PiDiagnosticResult> {
  const isReasoning =
    !!cred.thinking_effort &&
    cred.thinking_effort !== "off" &&
    cred.thinking_effort !== "none";

  const t0 = Date.now();
  const state: ProgressiveState = {
    l1: false,
    l2: false,
    l3Call: false,
    l3Result: false,
    l4: false,
    hasError: false,
    errorMessage: null,
    assistantMessageCount: 0,
    emitted: new Set(),
  };

  // Emit check_started for all applicable layers up front (progressive UI)
  const startCheck = (id: DiagnosticCheckId, layer: DiagnosticLayer) => {
    emit({
      type: "check_started",
      check: { id, label: id, layer, status: "pass", message: "testing" },
    });
  };
  startCheck("basic", "L1");
  if (isReasoning) startCheck("thinking", "L2");
  else {
    // Non-reasoning: L2 is N/A immediately
    const na: DiagnosticCheck = {
      id: "thinking", label: "thinking", layer: "L2", status: "na", message: "not_reasoning",
    };
    emit({ type: "check_passed", check: na });
    state.emitted.add("thinking");
  }
  startCheck("tool", "L3");
  startCheck("l4_agent", "L4");

  // ── Run the CLI once, progressive onEvent ──
  const cliResult: CredentialCliResult = await runCredentialCliCheck(
    {
      proto_type: cred.proto_type,
      base_url: cred.base_url,
      model_id: cred.model_id,
      thinking_effort: cred.thinking_effort,
      context_window_tokens: cred.context_window_tokens,
      max_output_tokens: (cred as any).max_output_tokens ?? null,
      api_key: cred.api_key,
      advanced_config: (cred as any).advanced_config ?? null,
    },
    {
      onEvent: (ev) => feedProgressiveEvent(state, ev, emit, { isReasoning, t0 }),
    },
  );

  const elapsed = cliResult.durationMs;

  // ── Derive error message for failure cases ──
  let failDetail: string;
  if (cliResult.timedOut) {
    failDetail = formatRawError(`timeout after ${120}s`);
  } else if (state.hasError && state.errorMessage) {
    failDetail = formatRawError(state.errorMessage, undefined, cred.api_key);
  } else if (cliResult.events.length === 0) {
    failDetail = cliResult.stderr.trim().slice(0, 300) || "pi CLI produced no output";
    failDetail = formatRawError(failDetail, undefined, cred.api_key);
  } else {
    failDetail = formatRawError(
      state.l4
        ? "Agent completed but layer assertions failed"
        : "pi CLI did not reach agent_settled state",
      undefined, cred.api_key,
    );
  }

  // ── Finalize layers not yet passed ──
  const checks: DiagnosticCheck[] = [];

  const finalize = (
    id: DiagnosticCheckId,
    layer: DiagnosticLayer,
    passed: boolean,
    passMsg: string,
    failMsg: string,
    failDetailMsg?: string,
  ): DiagnosticCheck => {
    if (passed) {
      // May already have been progressive-emitted
      if (!state.emitted.has(id)) {
        const check: DiagnosticCheck = {
          id, label: id, layer, status: "pass", message: passMsg, durationMs: elapsed,
        };
        emit({ type: "check_passed", check });
        state.emitted.add(id);
        return check;
      }
      return {
        id, label: id, layer, status: "pass", message: passMsg, durationMs: elapsed,
      };
    }
    const check: DiagnosticCheck = {
      id, label: id, layer, status: "fail",
      message: failMsg,
      durationMs: elapsed,
      detail: failDetailMsg,
    };
    emit({ type: "check_failed", check });
    return check;
  };

  // L1
  checks.push(finalize(
    "basic", "L1",
    state.l1 && !cliResult.timedOut,
    "text_response_ok",
    failDetail,
    failDetail,
  ));

  // L1 hard-fail → stop (still report remaining as fail/na for UI completeness)
  if (checks[0].status === "fail") {
    if (isReasoning && !state.emitted.has("thinking")) {
      checks.push({
        id: "thinking", label: "thinking", layer: "L2", status: "fail",
        message: "skipped_after_l1_fail", durationMs: elapsed,
      });
    } else if (!isReasoning) {
      checks.push({
        id: "thinking", label: "thinking", layer: "L2", status: "na", message: "not_reasoning",
      });
    } else {
      checks.push({
        id: "thinking", label: "thinking", layer: "L2", status: "pass",
        message: "thinking_confirmed", durationMs: elapsed,
      });
    }
    checks.push({
      id: "tool", label: "tool", layer: "L3", status: "fail",
      message: "skipped_after_l1_fail", durationMs: elapsed,
    });
    checks.push({
      id: "l4_agent", label: "l4_agent", layer: "L4", status: "fail",
      message: "skipped_after_l1_fail", durationMs: elapsed,
    });
    const summary = failDetail;
    emit({ type: "report", checks, ok: false, summary });
    return { ok: false, checks, summary };
  }

  // L2
  if (!isReasoning) {
    checks.push({
      id: "thinking", label: "thinking", layer: "L2", status: "na", message: "not_reasoning",
    });
  } else {
    // fish 2026-08-10: L2 "no thinking blocks" is a WARN, not a hard fail.
    // Some gateways (CloudRouter) don't pass through reasoning_content even
    // though the model reasons inline. The credential is still usable.
    if (state.l2) {
      checks.push(finalize(
        "thinking", "L2",
        true,
        "thinking_confirmed",
        "thinking_not_observed",
        "Reasoning was enabled but no thinking content blocks were observed in the response",
      ));
    } else {
      const warnCheck: DiagnosticCheck = {
        id: "thinking", label: "thinking", layer: "L2", status: "warn",
        message: "thinking_not_observed",
        durationMs: elapsed,
        detail: "Reasoning was enabled but no thinking content blocks were observed in the response",
      };
      emit({ type: "check_passed", check: warnCheck });
      checks.push(warnCheck);
    }
  }

  // L3
  checks.push(finalize(
    "tool", "L3",
    state.l3Call && state.l3Result,
    "tool_call_observed",
    "tool_call_not_observed",
    "No clean read tool call was observed in the event stream",
  ));

  // L4
  const l4Pass = state.l4 && !state.hasError;
  if (l4Pass && !state.emitted.has("l4_agent")) {
    const check: DiagnosticCheck = {
      id: "l4_agent", label: "l4_agent", layer: "L4", status: "pass",
      message: `agent_circuit_ok (pi ${PI_VERSION}, ${state.assistantMessageCount} assistant message(s))`,
      durationMs: elapsed,
    };
    emit({ type: "check_passed", check });
    state.emitted.add("l4_agent");
    checks.push(check);
  } else if (l4Pass) {
    checks.push({
      id: "l4_agent", label: "l4_agent", layer: "L4", status: "pass",
      message: `agent_circuit_ok (pi ${PI_VERSION}, ${state.assistantMessageCount} assistant message(s))`,
      durationMs: elapsed,
    });
  } else {
    checks.push(finalize(
      "l4_agent", "L4",
      false,
      "",
      "agent_circuit_failed",
      failDetail,
    ));
  }

  // ok = all pass/na, OR only L2 is warn (rest pass/na). fish 2026-08-10.
  const hasFail = checks.some((c) => c.status === "fail");
  const ok = !hasFail && checks.every((c) =>
    c.status === "pass" || c.status === "na" ||
    (c.id === "thinking" && c.status === "warn"),
  );
  const summary = ok
    ? `四层诊断通过（${elapsed}ms）`
    : (checks.find((c) => c.status === "fail")?.message ?? "诊断未通过");
  emit({ type: "report", checks, ok, summary });
  return { ok, checks, summary };
}
