/** Shared settings-page building blocks (extracted from SettingsPage). */
import type { CSSProperties, ReactNode } from "react";
import { Icon, type IconName } from "../../../shared/components/Icon.js";


export const CARD: CSSProperties = {
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: "12px",
  padding: "24px",
  marginBottom: "16px",
};

export const FIELD_LABEL: CSSProperties = {
  display: "block",
  fontSize: "11px",
  fontWeight: 600,
  color: "var(--text-secondary)",
  marginBottom: "6px",
  letterSpacing: "0.04em",
};

export const FIELD_INPUT: CSSProperties = {
  display: "block",
  width: "100%",
  height: "40px",
  padding: "0 12px",
  border: "1px solid var(--border)",
  borderRadius: "8px",
  fontSize: "14px",
  color: "var(--text-primary)",
  background: "var(--bg-card)",
  outline: "none",
  transition: "border-color 0.15s",
  fontFamily: "inherit",
  boxSizing: "border-box",
};

export const FIELD_HINT: CSSProperties = {
  fontSize: "12px",
  color: "var(--text-secondary)",
  marginTop: "4px",
  opacity: 0.85,
  margin: "4px 0 0",
};

/* -------------------------------------------------------------------------- */
/*  Small building blocks                                                     */
/* -------------------------------------------------------------------------- */

export function SettingsCard({
  icon,
  title,
  desc,
  children,
  testid,
  actions,
}: {
  icon: IconName;
  title: string;
  desc: string;
  children: ReactNode;
  testid?: string;
  actions?: ReactNode;
}) {
  return (
    <section style={CARD} data-testid={testid}>
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: "12px",
          marginBottom: "20px",
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3
            style={{
              fontSize: "15px",
              fontWeight: 600,
              margin: "0 0 4px",
              display: "flex",
              alignItems: "center",
              gap: "8px",
              color: "var(--text-primary)",
            }}
          >
            <Icon
              name={icon}
              size={18}
              style={{ color: "var(--text-secondary)" }}
            />
            <span>{title}</span>
          </h3>
          <p
            style={{
              fontSize: "13px",
              color: "var(--text-secondary)",
              opacity: 0.85,
              margin: 0,
            }}
          >
            {desc}
          </p>
        </div>
        {actions ? <div style={{ flexShrink: 0 }}>{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}


export function Field({
  label,
  hint,
  children,
}: {
  label?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div style={{ marginBottom: "18px" }}>
      {label ? <label style={FIELD_LABEL}>{label}</label> : null}
      {children}
      {hint ? <p style={FIELD_HINT}>{hint}</p> : null}
    </div>
  );
}

export function SegGroup<T extends string>({
  items,
  value,
  onChange,
  testid,
}: {
  items: Array<{ value: T; label: ReactNode }>;
  value: T;
  onChange: (v: T) => void;
  testid?: string;
}) {
  return (
    <div
      role="radiogroup"
      data-testid={testid}
      style={{
        display: "inline-flex",
        gap: 0,
        border: "1px solid var(--border)",
        borderRadius: "8px",
        padding: "3px",
        background: "var(--bg-page)",
      }}
    >
      {items.map((it) => {
        const active = it.value === value;
        return (
          <button
            key={it.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(it.value)}
            data-seg-value={it.value}
            data-active={active || undefined}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              padding: "6px 16px",
              fontSize: "13px",
              fontWeight: active ? 600 : 500,
              color: active ? "var(--text-primary)" : "var(--text-secondary)",
              background: active ? "var(--bg-card)" : "transparent",
              border: "none",
              borderRadius: "6px",
              cursor: "pointer",
              transition: "all 0.15s",
              boxShadow: active ? "0 1px 2px rgba(0,0,0,0.08)" : "none",
              lineHeight: 1,
            }}
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  The page                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Pure protocol type — this drives which API shape pi-cli/worker uses
 * when talking to the LLM endpoint. Changed from a provider abstraction
 * (anthropic/openai/minimax/custom) to 3 protocol options per Architect's
 * correction: pi's models.json `api` field must be one of these three
 * strings, otherwise endpoints like DeepSeek/mimo/kimi fail.
 */

export function ensureSpinKeyframes() {
  if (typeof document === "undefined") return;
  if (document.getElementById("va-spin-keyframes")) return;
  const style = document.createElement("style");
  style.id = "va-spin-keyframes";
  style.textContent =
    "@keyframes va-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }";
  document.head.appendChild(style);
}

