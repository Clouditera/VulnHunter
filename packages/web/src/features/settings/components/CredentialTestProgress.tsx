/**
 * CredentialTestProgress — progressive credential test log.
 *
 * Renders each check as it starts/passes/fails ("API 端点连接测试中… →
 * 成功") instead of dumping the full report at the end (fish 2026-08-04).
 *
 * Transport: SSE event contract (architect-pinned, shared with B核-B):
 *   { type: "check_started|check_passed|check_failed|report", check: {...} }
 * Endpoint: POST /api/settings/credential/diagnose-stream.
 * Consumed via `streamCredentialTest` below.
 */

import { useEffect, useState } from "react";
import { i18n } from "../../../shared/i18n/index.js";
import { Icon } from "../../../shared/components/Icon.js";
import type { ModelDiagnosticCheck, ModelDiagnosticResult } from "../../../shared/api/client.js";

export interface TestProgressProps {
  /** Live checks in render order (started/pending/running → pass/fail/na). */
  checks: ModelDiagnosticCheck[];
  /** Final report once the stream completes. */
  report?: ModelDiagnosticResult | null;
  running: boolean;
}

/**
 * Resolve a check's display label via i18n (check.id is the stable key).
 * Backend payloads carry a raw label only as fallback — user-facing copy
 * always resolves locally (registry principle: server stays language-neutral).
 */
function checkLabel(check: ModelDiagnosticCheck): string {
  const key = `diagnostics.check.${check.id}`;
  const translated = i18n.t(key);
  return translated && translated !== key ? translated : check.label;
}

function FailureGuidance({ checks }: { checks: ModelDiagnosticCheck[] }) {
  const failedChecks = checks.filter((check) => check.status === "fail");
  if (failedChecks.length === 0) return null;

  return (
    <div
      data-testid="test-failure-guidance"
      style={{
        padding: "10px 12px",
        borderTop: "1px solid rgba(194,40,40,0.28)",
        background: "var(--bg-error)",
        color: "var(--danger)",
        fontSize: 12,
        lineHeight: 1.6,
      }}
    >
      {failedChecks.map((check) => (
        <div key={check.id} style={{ marginBottom: failedChecks.length > 1 ? 8 : 0 }}>
          <div>
            <strong>{i18n.t("settings.model.testFailureReason")}：</strong>
            {checkLabel(check)} —{" "}
            {check.detail || check.message || i18n.t("settings.model.testFailureReasonUnknown")}
          </div>
          <div>
            <strong>{i18n.t("settings.model.testFailureSolution")}：</strong>
            {check.suggestion || i18n.t("settings.model.testFailureSolutionDefault")}
          </div>
        </div>
      ))}
    </div>
  );
}

function TestConclusion({ checks, ok }: { checks: ModelDiagnosticCheck[]; ok: boolean }) {
  // Success renders nothing (fish 2026-08-06: 成功结论块多此一举——四行
  // 绿勾已说明一切). Failure keeps the reason+solution guidance block.
  if (ok) return null;
  return <FailureGuidance checks={checks} />;
}

function StatusIcon({ status }: { status: string }) {
  if (status === "pass")
    return <Icon name="check-circle" size={14} style={{ color: "var(--status-completed)" }} />;
  if (status === "fail")
    return <Icon name="alert-circle" size={14} style={{ color: "var(--danger)" }} />;
  if (status === "na" || status === "skip")
    return <Icon name="minus-circle" size={14} style={{ color: "var(--text-tertiary)" }} />;
  return (
    <span
      aria-label="running"
      style={{
        width: 12,
        height: 12,
        borderRadius: "50%",
        border: "2px solid var(--brand-soft)",
        borderTopColor: "var(--brand)",
        display: "inline-block",
        animation: "vh-cred-test-spin 0.9s linear infinite",
      }}
    />
  );
}

export function CredentialTestProgress({ checks, report, running }: TestProgressProps) {
  const [, tick] = useState(0);
  useEffect(() => i18n.onChange(() => tick((n) => n + 1)), []);
  const [expanded, setExpanded] = useState<string | null>(null);

  // fish 2026-08-06 ②: thinking OFF → the thinking card does not render at
  // all (backend emits an na "not_reasoning" row in that case — hide it;
  // a real run with thinking enabled still shows pass/na-not-observed).
  const visibleChecks = checks.filter(
    (c) => !(c.id === "thinking" && c.message === "not_reasoning"),
  );

  if (visibleChecks.length === 0 && !report) return null;

  return (
    <div
      data-testid="credential-test-progress"
      style={{
        border: "1px solid var(--border)",
        borderRadius: 8,
        background: "var(--bg-page)",
        overflow: "hidden",
      }}
    >
      <style>{`@keyframes vh-cred-test-spin{to{transform:rotate(360deg)}}`}</style>
      {visibleChecks.map((c) => {
        const done = ["pass", "fail", "na", "skip"].includes(c.status);
        const active = !done;
        const hasDetail = Boolean(c.detail || c.suggestion || c.httpStatus || c.endpoint);
        const isOpen = expanded === c.id;
        return (
          <div key={c.id} data-testid={`test-check-${c.id}`} data-status={c.status}>
            <button
              type="button"
              disabled={!hasDetail}
              onClick={() => setExpanded(isOpen ? null : c.id)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                width: "100%",
                padding: "8px 12px",
                border: "none",
                borderBottom: "1px solid var(--divider)",
                background: "transparent",
                cursor: hasDetail ? "pointer" : "default",
                textAlign: "left",
                fontSize: 12.5,
                color: "var(--text-primary)",
              }}
            >
              <StatusIcon status={c.status} />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ fontWeight: 600 }}>{checkLabel(c)}</span>
                <span style={{ color: "var(--text-secondary)" }}>
                  {" "}
                  {active
                    ? i18n.t("settings.model.testProgress.running")
                    : c.id === "l4_agent"
                      ? i18n.t(c.status === "pass" ? "diagnostics.l4.passed" : "diagnostics.l4.failed")
                      : c.message}
                </span>
              </span>
              {typeof c.durationMs === "number" && done ? (
                <span
                  style={{
                    fontSize: 11,
                    color: "var(--text-tertiary)",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {(c.durationMs / 1000).toFixed(1)}s
                </span>
              ) : null}
              {hasDetail ? (
                <Icon
                  name="chevron-down"
                  size={12}
                  style={{
                    color: "var(--icon-muted)",
                    transform: isOpen ? "rotate(180deg)" : "none",
                    transition: "transform .15s",
                  }}
                />
              ) : null}
            </button>
            {isOpen && hasDetail ? (
              <div
                style={{
                  padding: "8px 12px 10px 34px",
                  borderBottom: "1px solid var(--divider)",
                  fontFamily: "var(--font-mono)",
                  fontSize: 11.5,
                  lineHeight: 1.6,
                  color: "var(--text-secondary)",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                {c.suggestion
                  ? `${i18n.t("settings.model.testProgress.suggestion")}：${c.suggestion}\n`
                  : ""}
                {c.httpStatus ? `HTTP：${c.httpStatus}\n` : ""}
                {c.endpoint ? `Endpoint：${c.endpoint}\n` : ""}
                {c.detail ?? ""}
              </div>
            ) : null}
          </div>
        );
      })}
      {report && !running ? (
        <div
          data-testid="test-progress-summary"
          style={{
            padding: "8px 12px",
            fontSize: 12,
            fontWeight: 600,
            color: report.ok ? "var(--status-completed)" : "var(--danger)",
          }}
        >
          {report.ok ? i18n.t("settings.model.testOk") : report.summary}
        </div>
      ) : null}
      {!running ? (
        <TestConclusion
          checks={checks}
          ok={report?.ok ?? !checks.some((c) => c.status === "fail")}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* SSE transport                              */
/* ------------------------------------------------------------------ */

export type TestStreamEvent =
  | { type: "check_started" | "check_passed" | "check_failed"; check: ModelDiagnosticCheck }
  | { type: "report"; report: ModelDiagnosticResult };

export interface TestStreamHandlers {
  onEvent: (ev: TestStreamEvent) => void;
  onError: (err: unknown) => void;
  /**
   * Stream ended. `sawReport=false` means no terminal report frame arrived
   * (truncation/close-race/proxy-drop) — caller must finalize the UI from
   * the accumulated checks instead of hanging in "loading" forever
   * (fish 2026-08-04: 三项全绿但按钮卡在「测试中…」).
   */
  onComplete?: (sawReport: boolean) => void;
}

/**
 * POST the credential test with SSE streaming. Requires fetch streaming
 * (all supported browsers).
 */
export async function streamCredentialTest(
  payload: Record<string, unknown>,
  handlers: TestStreamHandlers,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch("/api/settings/credential/diagnose-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      credentials: "same-origin",
      body: JSON.stringify(payload),
    });
  } catch (err) {
    handlers.onError(err);
    return;
  }
  if (!res.ok || !res.body) {
    handlers.onError(new Error(`HTTP ${res.status}`));
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let sawReport = false;
  // Minimal SSE frame parser (data: lines, blank-line delimited)
  const handleFrame = (frame: string) => {
    const dataLines = frame
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart());
    if (dataLines.length === 0) return;
    try {
      const parsed = JSON.parse(dataLines.join("\n")) as TestStreamEvent & {
        check?: ModelDiagnosticCheck;
        report?: ModelDiagnosticResult;
      };
      if (parsed.type === "report") {
        sawReport = true;
        handlers.onEvent({
          type: "report",
          report:
            (parsed as { report: ModelDiagnosticResult }).report ??
            (parsed as unknown as ModelDiagnosticResult),
        });
      } else if (parsed.check) {
        handlers.onEvent({ type: parsed.type, check: parsed.check } as TestStreamEvent);
      }
    } catch {
      /* ignore malformed frame */
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      handleFrame(frame);
    }
  }
  // Flush a trailing frame whose terminating blank line never arrived
  // (server closed right after the final write).
  if (buf.trim()) handleFrame(buf);
  handlers.onComplete?.(sawReport);
}
