import { useEffect, useState, type ReactNode } from "react";
import { i18n } from "../i18n/index.js";

/**
 * Split-screen auth layout used by Login / Activate / Expired / Bootstrap.
 * Left 55% = brand red with giant "V" lettermark; Right 45% = form card.
 * Matches prototype `login-brand` + `form-wrap`.
 */
export function AuthLanguageSelect() {
  const [, forceI18n] = useState(0);
  useEffect(() => i18n.onChange(() => forceI18n((n) => n + 1)), []);

  return (
    <select
      data-testid="auth-lang-select"
      aria-label={i18n.locale() === "zh" ? "语言" : "Language"}
      value={i18n.locale()}
      onChange={(e) => i18n.setLocale(e.target.value as "zh" | "en")}
      style={{
        position: "absolute",
        top: "20px",
        right: "24px",
        zIndex: 2,
        height: "32px",
        border: "1px solid var(--border)",
        borderRadius: "8px",
        background: "var(--bg-card)",
        color: "var(--text-secondary)",
        fontSize: "13px",
        padding: "0 10px",
        outline: "none",
      }}
    >
      <option value="zh">中文</option>
      <option value="en">English</option>
    </select>
  );
}

export function AuthSplitLayout({ children, testid }: { children: ReactNode; testid?: string }) {
  return (
    <div
      data-testid={testid}
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        background: "var(--bg-page)",
        zIndex: 50,
      }}
    >
      <AuthLanguageSelect />

      {/* Left: brand panel */}
      <div
        style={{
          flex: "0 0 55%",
          background: "var(--brand)",
          color: "#fff",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "40px",
          userSelect: "none",
        }}
      >
        <div
          aria-hidden
          style={{
            fontSize: "clamp(120px, 16vw, 200px)",
            fontWeight: 800,
            lineHeight: 1,
            letterSpacing: "-0.06em",
          }}
        >
          V
        </div>
        <div style={{ fontSize: "28px", fontWeight: 700, marginTop: "8px", letterSpacing: "0.08em" }}>
          VulnHunt
        </div>
        <div style={{ fontSize: "15px", opacity: 0.82, marginTop: "6px" }}>
          AI-Powered Security Audit
        </div>
      </div>

      {/* Right: form */}
      <div
        style={{
          flex: "1 1 45%",
          background: "var(--bg-card)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "40px",
          overflow: "auto",
        }}
      >
        <div style={{ width: "340px", maxWidth: "100%" }}>{children}</div>
      </div>
    </div>
  );
}
