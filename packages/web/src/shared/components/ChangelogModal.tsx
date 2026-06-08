import type { CSSProperties } from "react";
import { Markdown } from "../../features/chat/components/Markdown.js";
import { CHANGELOG_MARKDOWN, CURRENT_VERSION } from "../changelog.js";

/**
 * Login-time changelog popup. Centered modal, scrollable body, single
 * "I got it" action. Backdrop is intentionally NOT click-to-close so users
 * don't accidentally dismiss the announcement.
 */
export function ChangelogModal({ onClose }: { onClose: () => void }) {
  return (
    <div data-testid="changelog-modal" style={BACKDROP}>
      <div style={MODAL} role="dialog" aria-modal="true" aria-label="Version changelog">
        <div style={HEADER}>
          <span style={TITLE}>🎉 VulnAgent v{CURRENT_VERSION} 更新</span>
        </div>
        <div className="va-changelog-scroll" style={BODY}>
          <Markdown content={CHANGELOG_MARKDOWN} />
        </div>
        <div style={FOOTER}>
          <button
            type="button"
            data-testid="changelog-dismiss"
            onClick={onClose}
            style={BUTTON}
          >
            我知道了
          </button>
        </div>
      </div>
    </div>
  );
}

const BACKDROP: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.45)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
  padding: "20px",
};
const MODAL: CSSProperties = {
  width: "600px",
  maxWidth: "100%",
  maxHeight: "70vh",
  display: "flex",
  flexDirection: "column",
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: "12px",
  boxShadow: "0 12px 40px rgba(0,0,0,0.25)",
  overflow: "hidden",
};
const HEADER: CSSProperties = {
  padding: "18px 24px",
  borderBottom: "1px solid var(--divider)",
  flexShrink: 0,
};
const TITLE: CSSProperties = {
  fontSize: "17px",
  fontWeight: 700,
  color: "var(--text-primary)",
};
const BODY: CSSProperties = {
  padding: "8px 24px",
  overflowY: "auto",
  flex: 1,
  color: "var(--text-primary)",
  fontSize: "14px",
  lineHeight: 1.6,
};
const FOOTER: CSSProperties = {
  padding: "14px 24px",
  borderTop: "1px solid var(--divider)",
  display: "flex",
  justifyContent: "flex-end",
  flexShrink: 0,
};
const BUTTON: CSSProperties = {
  padding: "9px 20px",
  borderRadius: "8px",
  background: "var(--brand)",
  color: "#fff",
  fontSize: "13px",
  fontWeight: 600,
  border: "none",
  cursor: "pointer",
};
