import type { CSSProperties, ReactNode } from "react";
import { Link } from "react-router-dom";
import { Icon } from "../../../../shared/components/Icon.js";
import { i18n } from "../../../../shared/i18n/index.js";

export const SECTION: CSSProperties = {
  padding: "14px 18px",
  borderBottom: "1px solid var(--divider)",
};
export const TITLE: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "var(--text-primary)",
  marginBottom: 10,
};

export function LoadingState() {
  return <StateWrap testId="ref-loading" icon="loader" text={i18n.t("chat.ref.loading")} spin />;
}

export function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div data-testid="ref-error" style={STATE_WRAP}>
      <Icon
        name="alert-triangle"
        size={24}
        style={{ color: "var(--text-secondary)", opacity: 0.5 }}
      />
      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
        {i18n.t("chat.ref.error")}
      </div>
      <button type="button" data-testid="ref-retry-btn" onClick={onRetry} style={SMALL_BUTTON}>
        {i18n.t("chat.ref.retry")}
      </button>
    </div>
  );
}

export function NotFoundState() {
  return (
    <div data-testid="ref-not-found" style={STATE_WRAP}>
      <Icon name="x" size={24} style={{ color: "var(--text-secondary)", opacity: 0.5 }} />
      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
        {i18n.t("chat.ref.notFound")}
      </div>
      <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
        {i18n.t("chat.ref.notFoundHint")}
      </div>
    </div>
  );
}

function StateWrap({
  testId,
  icon,
  text,
  spin,
}: { testId: string; icon: "loader"; text: string; spin?: boolean }) {
  return (
    <div data-testid={testId} style={STATE_WRAP}>
      <Icon
        name={icon}
        size={24}
        style={{
          color: "var(--text-secondary)",
          animation: spin ? "va-ref-spin 1s linear infinite" : undefined,
        }}
      />
      <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>{text}</div>
    </div>
  );
}

export function DetailHeader({
  icon,
  color,
  title,
  to,
  action,
}: {
  icon: Parameters<typeof Icon>[0]["name"];
  color: string;
  title: string;
  to?: string;
  action?: ReactNode;
}) {
  return (
    <div
      style={{
        padding: "16px 18px",
        borderBottom: "1px solid var(--divider)",
        display: "flex",
        alignItems: "center",
        gap: 10,
      }}
    >
      <Icon name={icon} size={18} style={{ color, flexShrink: 0 }} />
      <div
        style={{
          fontSize: 14,
          fontWeight: 700,
          color: "var(--text-primary)",
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {title}
      </div>
      {action ?? (to ? <JumpLink to={to} /> : null)}
    </div>
  );
}

export function JumpLink({ to }: { to: string }) {
  return (
    <Link
      data-testid="ref-jump-link"
      to={to}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 2,
        fontSize: 12,
        fontWeight: 500,
        color: "var(--brand)",
        textDecoration: "none",
        whiteSpace: "nowrap",
      }}
    >
      {i18n.t("chat.ref.jumpToDetail")}
      <Icon name="chevron-right" size={12} />
    </Link>
  );
}

export function KvRow({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "baseline",
        gap: 12,
        padding: "9px 18px",
        borderBottom: "1px solid var(--divider)",
      }}
    >
      <span style={{ fontSize: 12, fontWeight: 500, color: "var(--text-secondary)" }}>{label}</span>
      <span
        style={{
          fontSize: 13,
          fontWeight: 500,
          color: "var(--text-primary)",
          fontFamily: mono ? "monospace" : undefined,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {value}
      </span>
    </div>
  );
}

export function StatusPill({ value }: { value: string }) {
  return (
    <span
      style={{
        padding: "2px 8px",
        borderRadius: 999,
        background: "var(--bg-active-filter)",
        color: "var(--text-primary)",
        fontSize: 11,
        fontWeight: 700,
      }}
    >
      {value}
    </span>
  );
}

export function severityColor(sev?: string | null): string {
  const s = (sev ?? "").toLowerCase();
  if (s.includes("high") || s.includes("critical")) return "var(--sev-high)";
  if (s.includes("medium")) return "var(--sev-medium)";
  if (s.includes("low")) return "var(--sev-low)";
  return "var(--sev-info)";
}

export function stringifySection(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function formatDuration(ms?: number | null): string {
  if (!ms) return "—";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60_000)}min`;
}

export function formatTime(value?: string | null): string {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return "—";
  }
}

export const SMALL_BUTTON: CSSProperties = {
  padding: "6px 14px",
  borderRadius: 6,
  fontSize: 12,
  fontWeight: 500,
  border: "1px solid var(--border)",
  background: "var(--bg-card)",
  color: "var(--text-primary)",
  cursor: "pointer",
};

const STATE_WRAP: CSSProperties = {
  flex: 1,
  minHeight: 260,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 12,
  textAlign: "center",
  padding: 24,
};
