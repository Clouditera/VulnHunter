import type { ReactNode } from "react";

/**
 * Split-screen auth layout used by Login / Activate / Expired / Bootstrap.
 * Left 55% = brand red with giant "V" lettermark; Right 45% = form card.
 * Matches prototype `login-brand` + `form-wrap`.
 */
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
