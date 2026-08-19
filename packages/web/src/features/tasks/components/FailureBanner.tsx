/**
 * Failure banner — shown only when task.state === 'failed'.
 *
 * HALL-4: failure_reason crosses the engine → platform boundary and may be
 * either legacy plain text or a structured JSON payload ({code, message,
 * details?}) polluted with Docker stdcopy frame bytes. Rendering pipeline:
 *   1. sanitizeErrorText — strip control chars (covers legacy dirty rows);
 *   2. parseStructuredFailure — object with string `code` → structured view
 *      (readable message + code badge + registry guiding action), raw JSON
 *      tucked into a collapsed diagnostics block;
 *   3. anything else → plain text, behaviour unchanged.
 */

import {
  ERROR_REGISTRY,
  getErrorEntry,
  parseStructuredFailure,
  sanitizeErrorText,
} from "@vulnhunter/shared";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Icon } from "../../../shared/components/Icon.js";
import { i18n } from "../../../shared/i18n/index.js";

export function FailureBanner({ failureReason }: { failureReason?: string | null }) {
  const navigate = useNavigate();
  const [showDetails, setShowDetails] = useState(false);

  const cleaned = sanitizeErrorText((failureReason ?? "").trim());
  const structured = cleaned ? parseStructuredFailure(cleaned) : null;
  const registered = structured !== null && structured.code in ERROR_REGISTRY;
  const action = structured && registered ? getErrorEntry(structured.code).action : undefined;
  const navigateTo = action && action.kind === "navigate" ? action.to : null;
  const mainText = structured ? sanitizeErrorText(structured.message).trim() : cleaned;

  function expandLog() {
    const el = document.querySelector<HTMLElement>('[data-testid="live-log-expand-btn"]');
    if (el) {
      // Expand if collapsed, then scroll it into view.
      const panel = document.querySelector<HTMLElement>('[data-testid="live-log-stream"]');
      if (!panel) el.click();
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  return (
    <div
      data-testid="task-failure-banner"
      style={{
        marginTop: "14px",
        display: "flex",
        gap: "12px",
        alignItems: "flex-start",
        padding: "12px 14px",
        background: "var(--bg-error)",
        border: "1px solid rgba(194,40,40,0.28)",
        borderLeft: "3px solid var(--brand)",
        borderRadius: "8px",
      }}
    >
      <Icon name="alert-triangle" size={18} style={{ color: "var(--brand)", marginTop: "1px" }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: "13px",
            fontWeight: 600,
            color: "var(--brand)",
            marginBottom: "4px",
            lineHeight: 1.3,
            display: "flex",
            alignItems: "center",
            gap: "8px",
            flexWrap: "wrap",
          }}
        >
          <span>{i18n.t("taskDetail.failure.title")}</span>
          {structured ? (
            <code
              data-testid="task-failure-code"
              style={{
                fontSize: "11px",
                fontWeight: 600,
                fontFamily: "'SF Mono', Menlo, Consolas, monospace",
                padding: "1px 6px",
                borderRadius: "4px",
                background: "rgba(194,40,40,0.12)",
                color: "var(--brand)",
              }}
            >
              {structured.code}
            </code>
          ) : null}
        </div>
        <div
          data-testid="task-failure-reason"
          style={{
            fontSize: "12px",
            color: "var(--text-primary)",
            lineHeight: 1.55,
            wordBreak: "break-word",
            whiteSpace: "pre-wrap",
            fontFamily: mainText ? "'SF Mono', Menlo, Consolas, monospace" : undefined,
          }}
        >
          {mainText || i18n.t("taskDetail.failure.noReason")}
        </div>
        {structured ? (
          <div style={{ marginTop: "6px" }}>
            <button
              type="button"
              data-testid="task-failure-details-toggle"
              onClick={() => setShowDetails((v) => !v)}
              aria-expanded={showDetails}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "4px",
                border: "none",
                background: "transparent",
                padding: 0,
                fontSize: "11px",
                color: "var(--text-secondary)",
                cursor: "pointer",
              }}
            >
              <Icon
                name="chevron-down"
                size={11}
                style={{
                  transform: showDetails ? "rotate(180deg)" : "none",
                  transition: "transform .15s",
                }}
              />
              {i18n.t("errors.diagnostics")}
            </button>
            {showDetails ? (
              <pre
                data-testid="task-failure-details"
                style={{
                  margin: "6px 0 0",
                  padding: "8px 10px",
                  borderRadius: "6px",
                  background: "var(--bg-card)",
                  border: "1px solid var(--border)",
                  fontFamily: "'SF Mono', Menlo, Consolas, monospace",
                  fontSize: "11px",
                  lineHeight: 1.6,
                  color: "var(--text-secondary)",
                  maxHeight: "180px",
                  overflow: "auto",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                {cleaned}
              </pre>
            ) : null}
          </div>
        ) : null}
      </div>
      {navigateTo ? (
        <button
          type="button"
          data-testid="task-failure-action"
          onClick={() => navigate(navigateTo)}
          style={{
            flexShrink: 0,
            padding: "6px 12px",
            background: "transparent",
            border: "1px solid var(--brand)",
            borderRadius: "6px",
            color: "var(--brand)",
            fontSize: "12px",
            fontWeight: 600,
            cursor: "pointer",
            whiteSpace: "nowrap",
            lineHeight: 1,
          }}
        >
          {i18n.t("errors.action.go")}
        </button>
      ) : null}
      <button
        type="button"
        data-testid="task-failure-view-log"
        onClick={expandLog}
        style={{
          flexShrink: 0,
          padding: "6px 12px",
          background: "transparent",
          border: "1px solid var(--brand)",
          borderRadius: "6px",
          color: "var(--brand)",
          fontSize: "12px",
          fontWeight: 600,
          cursor: "pointer",
          whiteSpace: "nowrap",
          lineHeight: 1,
        }}
      >
        {i18n.t("taskDetail.failure.viewLog")}
      </button>
    </div>
  );
}
