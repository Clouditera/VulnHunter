/**
 * ErrorNotice — unified three-layer error presentation.
 *
 * Layers (spec: architecture/unified-error-handling-module-v1.0.md):
 *   1. user layer   — plain-language message + optional guiding action
 *   2. diagnostics  — expandable code / traceId / httpStatus / details JSON
 *   3. telemetry    — service-side structured log (not rendered here)
 *
 * Unregistered codes fall back to generic copy + expandable diagnostics:
 * raw codes/keys never render as the primary message.
 *
 * Placements:
 *   inline    — bordered danger-tint block (forms, settings, test reports)
 *   timeline  — compact variant for the task event stream
 *   toast     — handled by `toastFromError` (transient, top-right stack)
 */

import { useEffect, useState, type CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import { i18n } from "../i18n/index.js";
import { Icon } from "./Icon.js";
import { ApiError } from "../api/error.js";
import { toast } from "../toast/toast.js";

export type ErrorNoticePlacement = "inline" | "timeline";

export function ErrorNotice({
  error,
  placement = "inline",
  onAction,
  style,
}: {
  error: unknown;
  placement?: ErrorNoticePlacement;
  /** Override action behaviour (e.g. close a modal before navigating). */
  onAction?: (action: NonNullable<ApiError["spec"]["action"]>) => void;
  style?: CSSProperties;
}) {
  const navigate = useNavigate();
  const [, tick] = useState(0);
  const [open, setOpen] = useState(false);
  useEffect(() => i18n.onChange(() => tick((n) => n + 1)), []);

  const err = ApiError.from(error);
  const hasDiag =
    Boolean(err.code && err.code !== "ERR_UNKNOWN") ||
    Boolean(err.traceId) ||
    err.httpStatus !== undefined ||
    Boolean(err.details && Object.keys(err.details).length > 0);

  function runAction() {
    const action = err.spec.action;
    if (!action) return;
    if (onAction) {
      onAction(action);
      return;
    }
    if (action.kind === "navigate") navigate(action.to);
    // "retry" is contextual: caller passes onAction to implement it.
  }

  const compact = placement === "timeline";

  return (
    <div
      data-testid="error-notice"
      data-code={err.code}
      role="alert"
      style={{
        borderRadius: 8,
        border: "1px solid var(--danger-border)",
        background: "var(--danger-soft)",
        padding: compact ? "8px 10px" : "10px 12px",
        fontSize: compact ? 12 : 12.5,
        lineHeight: 1.55,
        color: "var(--text-primary)",
        ...style,
      }}
    >
      {/* user layer */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
        <Icon
          name="alert-triangle"
          size={compact ? 13 : 14}
          style={{ color: "var(--danger)", flexShrink: 0, marginTop: 2 }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>{err.userMessage}</div>
        {err.spec.action && err.spec.action.kind !== "none" ? (
          <button
            type="button"
            data-testid="error-notice-action"
            onClick={runAction}
            style={{
              flexShrink: 0,
              height: 24,
              padding: "0 10px",
              borderRadius: 5,
              border: "1px solid var(--danger-border)",
              background: "transparent",
              color: "var(--danger)",
              fontSize: 11,
              fontWeight: 600,
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            {i18n.t(
              err.spec.action.kind === "retry"
                ? "errors.action.retry"
                : "errors.action.go",
            )}
          </button>
        ) : null}
      </div>

      {/* diagnostics layer */}
      {hasDiag ? (
        <div style={{ marginTop: compact ? 4 : 6, paddingLeft: compact ? 21 : 22 }}>
          <button
            type="button"
            data-testid="error-notice-diag-toggle"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              border: "none",
              background: "transparent",
              padding: 0,
              fontSize: 11,
              color: "var(--text-secondary)",
              cursor: "pointer",
            }}
          >
            <Icon
              name="chevron-down"
              size={11}
              style={{
                transform: open ? "rotate(180deg)" : "none",
                transition: "transform .15s",
              }}
            />
            {i18n.t("errors.diagnostics")}
          </button>
          {open ? (
            <dl
              data-testid="error-notice-diag"
              style={{
                margin: "6px 0 0",
                padding: "8px 10px",
                borderRadius: 6,
                background: "var(--bg-card)",
                border: "1px solid var(--border)",
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                lineHeight: 1.7,
                color: "var(--text-secondary)",
                maxHeight: 180,
                overflow: "auto",
              }}
            >
              <DiagRow label="code" value={err.code} />
              {err.traceId ? <DiagRow label="traceId" value={err.traceId} /> : null}
              {err.httpStatus !== undefined ? (
                <DiagRow label="httpStatus" value={String(err.httpStatus)} />
              ) : null}
              {err.details && Object.keys(err.details).length > 0 ? (
                <DiagRow
                  label="details"
                  value={JSON.stringify(err.details, null, 1)}
                  pre
                />
              ) : null}
            </dl>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function DiagRow({ label, value, pre }: { label: string; value: string; pre?: boolean }) {
  return (
    <div style={{ display: "flex", gap: 8 }}>
      <dt style={{ flexShrink: 0, color: "var(--text-tertiary)" }}>{label}</dt>
      <dd
        style={{
          margin: 0,
          wordBreak: "break-all",
          whiteSpace: pre ? "pre-wrap" : undefined,
        }}
      >
        {value}
      </dd>
    </div>
  );
}

/**
 * Toast placement: transient notification for operation feedback.
 * Uses the registry-resolved user message; diagnostics stay available
 * by re-throwing into an inline surface (e.g. keep inline text in forms).
 */
export function toastFromError(err: unknown): void {
  toast.error(ApiError.from(err).userMessage);
}
