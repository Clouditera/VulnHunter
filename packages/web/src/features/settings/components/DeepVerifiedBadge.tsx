/**
 * DeepVerifiedBadge — L4 agent-loop deep verification marker on credential rows.
 *
 * Shows only when the backend reports a deep_verified_status (old
 * credentials render nothing). Functional colours are dots only; text
 * stays neutral (brand migration rule).
 */

import { useEffect, useState } from "react";
import { i18n } from "../../../shared/i18n/index.js";

export function DeepVerifiedBadge({
  status,
  at,
}: {
  status?: "pending" | "running" | "passed" | "failed" | null;
  at?: string | null;
}) {
  const [, tick] = useState(0);
  useEffect(() => i18n.onChange(() => tick((n) => n + 1)), []);
  if (!status) return null;

  const time = at ? new Date(at).toLocaleString() : "";
  const base: React.CSSProperties = {
    flexShrink: 0,
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    fontSize: 10,
    fontWeight: 500,
    lineHeight: 1.5,
    color: "var(--text-secondary)",
  };
  const dot = (color: string, pulse = false): React.ReactNode => (
    <span
      style={{
        width: 6,
        height: 6,
        borderRadius: "50%",
        background: color,
        display: "inline-block",
        animation: pulse ? "vh-dv-pulse 1.2s ease-in-out infinite" : undefined,
      }}
    />
  );

  if (status === "passed") {
    return (
      <span
        data-testid="credential-deep-verified"
        data-status="passed"
        title={time}
        style={base}
      >
        {dot("#3AD186")}
        {i18n.t("settings.creds.deepVerified.passed")}
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span
        data-testid="credential-deep-verified"
        data-status="failed"
        title={time}
        style={base}
      >
        {dot("var(--danger)")}
        {i18n.t("settings.creds.deepVerified.failed")}
      </span>
    );
  }
  // pending / running
  return (
    <span
      data-testid="credential-deep-verified"
      data-status={status}
      style={base}
    >
      <style>{`@keyframes vh-dv-pulse{0%,100%{opacity:.35}50%{opacity:1}}`}</style>
      {dot("var(--text-tertiary)", true)}
      {i18n.t("settings.creds.deepVerified.running")}
    </span>
  );
}
