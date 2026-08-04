import { useEffect, useState, type CSSProperties } from "react";
import { SUPPORT_EMAIL, supportMailto } from "../config/support.js";
import { i18n } from "../i18n/index.js";
import { copyText } from "../lib/copy-text.js";
import { Icon } from "./Icon.js";

/** Compact card: email + copy + mailto. Used by sidebar popover and login footer. */
export function SupportContactCard({
  testid = "support-contact-card",
  dense = false,
}: {
  testid?: string;
  dense?: boolean;
}) {
  const [, force] = useState(0);
  useEffect(() => i18n.onChange(() => force((n) => n + 1)), []);
  const [copied, setCopied] = useState(false);

  async function onCopy() {
    const ok = await copyText(SUPPORT_EMAIL);
    if (!ok) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div data-testid={testid} style={dense ? CARD_DENSE : CARD}>
      <div style={{ fontSize: dense ? 11 : 12, fontWeight: 700, color: dense ? "rgba(255,255,255,0.92)" : "var(--text-primary)", marginBottom: 6 }}>
        {i18n.t("support.cardTitle")}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <a
          data-testid={`${testid}-mailto`}
          href={supportMailto()}
          style={{
            color: "var(--brand)",
            fontSize: dense ? 12 : 13,
            fontWeight: 600,
            textDecoration: "none",
            wordBreak: "break-all",
          }}
        >
          {SUPPORT_EMAIL}
        </a>
        <button
          type="button"
          data-testid={`${testid}-copy`}
          onClick={() => void onCopy()}
          title={i18n.t("support.copy")}
          style={dense ? COPY_BTN_DARK : COPY_BTN_LIGHT}
        >
          <Icon name="copy" size={12} />
          <span>{copied ? i18n.t("support.copied") : i18n.t("support.copy")}</span>
        </button>
      </div>
    </div>
  );
}

/** Login / auth footer line — only render when caller gates saas. */
export function SupportContactFooterLine({ testid = "auth-support-contact" }: { testid?: string }) {
  const [, force] = useState(0);
  useEffect(() => i18n.onChange(() => force((n) => n + 1)), []);
  return (
    <div data-testid={testid} style={FOOTER_LINE}>
      {i18n.t("support.contactLabel")}{" "}
      <a href={supportMailto()} style={{ color: "var(--brand)", textDecoration: "none", fontWeight: 600 }}>
        {SUPPORT_EMAIL}
      </a>
    </div>
  );
}

/** Inline hint for feedback modal. */
export function SupportContactInline({ testid = "feedback-support-contact" }: { testid?: string }) {
  const [, force] = useState(0);
  useEffect(() => i18n.onChange(() => force((n) => n + 1)), []);
  return (
    <p data-testid={testid} style={{ margin: "12px 0 0", fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.5 }}>
      {i18n.t("support.alsoEmail")}{" "}
      <a href={supportMailto("VulnHunter feedback")} style={{ color: "var(--brand)", fontWeight: 600 }}>
        {SUPPORT_EMAIL}
      </a>
    </p>
  );
}

const CARD: CSSProperties = {
  padding: "12px 14px",
  borderRadius: 10,
  border: "1px solid var(--border)",
  background: "var(--bg-card)",
  boxShadow: "0 10px 30px rgba(0,0,0,0.18)",
};
const CARD_DENSE: CSSProperties = {
  ...CARD,
  padding: "10px 12px",
  background: "rgba(15,23,42,0.96)",
  border: "1px solid rgba(255,255,255,0.12)",
  color: "#fff",
};
const COPY_BTN_BASE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  height: 26,
  padding: "0 8px",
  borderRadius: 6,
  fontSize: 11,
  fontWeight: 600,
  cursor: "pointer",
};
const COPY_BTN_DARK: CSSProperties = {
  ...COPY_BTN_BASE,
  border: "1px solid rgba(255,255,255,0.18)",
  background: "rgba(255,255,255,0.08)",
  color: "rgba(255,255,255,0.85)",
};
const COPY_BTN_LIGHT: CSSProperties = {
  ...COPY_BTN_BASE,
  border: "1px solid var(--border)",
  background: "var(--bg-page)",
  color: "var(--text-secondary)",
};
const FOOTER_LINE: CSSProperties = {
  marginTop: 20,
  textAlign: "center",
  fontSize: 12,
  color: "var(--text-secondary)",
};
