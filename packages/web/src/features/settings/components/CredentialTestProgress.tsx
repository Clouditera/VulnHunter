/**
 * CredentialTestProgress — progressive credential test log.
 *
 * Renders each check as it starts/passes/fails ("API 端点连接测试中… →
 * 成功") instead of dumping the full report at the end (fish 2026-08-04).
 *
 * Transport: SSE event contract (architect-pinned, shared with B核-B):
 *   { type: "check_started|check_passed|check_failed|report", check: {...} }
 * Endpoint: POST /api/settings/credential/diagnose-stream.
 * Consumed via `streamCredentialTest` below; falls back to the legacy
 * run_id polling when the SSE endpoint is not deployed yet (404).
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

  if (checks.length === 0 && !report) return null;

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
      {checks.map((c) => {
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
                <span style={{ fontWeight: 600 }}>{c.label}</span>
                <span style={{ color: "var(--text-secondary)" }}>
                  {" "}
                  {active
                    ? i18n.t("settings.model.testProgress.running")
                    : c.message}
                </span>
              </span>
              {typeof c.durationMs === "number" && done ? (
                <span style={{ fontSize: 11, color: "var(--text-tertiary)", fontVariantNumeric: "tabular-nums" }}>
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
                {c.suggestion ? `${i18n.t("settings.model.testProgress.suggestion")}：${c.suggestion}\n` : ""}
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
          {report.summary}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* SSE transport with legacy-poll fallback                              */
/* ------------------------------------------------------------------ */

export type TestStreamEvent =
  | { type: "check_started" | "check_passed" | "check_failed"; check: ModelDiagnosticCheck }
  | { type: "report"; report: ModelDiagnosticResult };

export interface TestStreamHandlers {
  onEvent: (ev: TestStreamEvent) => void;
  /** Fallback to legacy polling when SSE endpoint absent. */
  onLegacy: () => void;
  onError: (err: unknown) => void;
}

/**
 * POST the credential test with SSE streaming. Requires fetch streaming
 * (all supported browsers). On HTTP 404 (endpoint not deployed) calls
 * `onLegacy` so the caller can run the existing run_id poll loop.
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
  if (res.status === 404) {
    handlers.onLegacy();
    return;
  }
  if (!res.ok || !res.body) {
    handlers.onError(new Error(`HTTP ${res.status}`));
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  // Minimal SSE frame parser (data: lines, blank-line delimited)
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLines = frame
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart());
      if (dataLines.length === 0) continue;
      try {
        const parsed = JSON.parse(dataLines.join("\n")) as TestStreamEvent & {
          check?: ModelDiagnosticCheck;
          report?: ModelDiagnosticResult;
        };
        if (parsed.type === "report") {
          handlers.onEvent({ type: "report", report: (parsed as { report: ModelDiagnosticResult }).report ?? (parsed as unknown as ModelDiagnosticResult) });
        } else if (parsed.check) {
          handlers.onEvent({ type: parsed.type, check: parsed.check } as TestStreamEvent);
        }
      } catch {
        /* ignore malformed frame */
      }
    }
  }
}
