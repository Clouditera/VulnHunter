import { useEffect } from "react";
import type { CSSProperties } from "react";
import { CHANGELOG_ENTRIES, getChangelogEntry, LATEST_CHANGELOG_ENTRY } from "../changelog.js";
import { i18n } from "../i18n/index.js";
import { ChangelogContent } from "./ChangelogModal.js";
import { BetaBadge } from "./BetaBadge.js";

interface ChangelogDrawerProps {
  open: boolean;
  runtimeVersion?: string;
  productName?: string;
  onClose: () => void;
}

export function ChangelogDrawer({ open, runtimeVersion, productName = "VulnHunter", onClose }: ChangelogDrawerProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const runtimeEntry = getChangelogEntry(runtimeVersion);
  const expandedVersion = runtimeEntry?.version ?? LATEST_CHANGELOG_ENTRY?.version;
  const hasRuntimeEntry = !!runtimeEntry || !runtimeVersion;

  return (
    <div data-testid="changelog-drawer" role="dialog" aria-modal="true" aria-label={i18n.t("changelog.title")} style={WRAP}>
      {/* Dim layer only — fish 2026-08-07: backdrop NEVER dismisses. */}
      <div style={BACKDROP_DIM} />
      <aside style={PANEL}>
        <header style={HEADER}>
          <div>
            <div style={EYEBROW}>{productName}</div>
            <h2 style={TITLE}>{i18n.t("changelog.title")}</h2>
            <div style={SUBTITLE}>
              {runtimeVersion
                ? i18n.t("changelog.currentVersion").replace("{version}", `v${runtimeVersion}`)
                : i18n.t("changelog.versionUnavailable")}
              {runtimeVersion ? <BetaBadge placement="bottom" /> : null}
            </div>
          </div>
          <button data-testid="changelog-drawer-close" type="button" onClick={onClose} style={CLOSE} aria-label={i18n.t("changelog.close")}>✕</button>
        </header>
        {!hasRuntimeEntry ? (
          <div style={NOTICE}>{i18n.t("changelog.latestFallback")}</div>
        ) : null}
        <div style={BODY}>
          {CHANGELOG_ENTRIES.map((entry) => (
            <details
              key={entry.version}
              data-testid={`changelog-entry-${entry.version}`}
              open={entry.version === expandedVersion}
              style={ENTRY}
            >
              <summary style={SUMMARY}>
                <span style={ENTRY_TITLE}>{entry.title ?? `${productName} v${entry.version}`}</span>
                {entry.releasedAt ? <span style={DATE}>{entry.releasedAt}</span> : null}
              </summary>
              <div style={ENTRY_BODY}>
                <ChangelogContent markdown={entry.markdown} />
              </div>
            </details>
          ))}
        </div>
      </aside>
    </div>
  );
}

const WRAP: CSSProperties = { position: "fixed", inset: 0, zIndex: 1000, display: "flex", justifyContent: "flex-end" };
const BACKDROP_DIM: CSSProperties = { position: "absolute", inset: 0, background: "rgba(0,0,0,0.36)" };
const PANEL: CSSProperties = { position: "relative", width: "min(520px, 92vw)", height: "100%", background: "var(--bg-card)", borderLeft: "1px solid var(--border)", boxShadow: "-16px 0 40px rgba(0,0,0,0.22)", display: "flex", flexDirection: "column" };
const HEADER: CSSProperties = { padding: "22px 24px", borderBottom: "1px solid var(--divider)", display: "flex", justifyContent: "space-between", gap: "16px", flexShrink: 0 };
const EYEBROW: CSSProperties = { fontSize: "11px", fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-secondary)", marginBottom: "6px" };
const TITLE: CSSProperties = { margin: 0, fontSize: "20px", fontWeight: 750, color: "var(--text-primary)" };
const SUBTITLE: CSSProperties = { marginTop: "8px", fontSize: "13px", color: "var(--text-secondary)", display: "flex", alignItems: "center", gap: "6px" };
const CLOSE: CSSProperties = { width: "32px", height: "32px", borderRadius: "8px", border: "1px solid var(--border)", background: "transparent", color: "var(--text-secondary)", cursor: "pointer", fontSize: "16px", flexShrink: 0 };
const NOTICE: CSSProperties = { margin: "14px 24px 0", padding: "10px 12px", borderRadius: "8px", background: "var(--bg-page)", color: "var(--text-secondary)", fontSize: "12px", border: "1px solid var(--border)" };
const BODY: CSSProperties = { padding: "18px 24px 28px", overflowY: "auto", flex: 1 };
const ENTRY: CSSProperties = { border: "1px solid var(--border)", borderRadius: "10px", marginBottom: "12px", background: "var(--bg-card)", overflow: "hidden" };
const SUMMARY: CSSProperties = { cursor: "pointer", padding: "14px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", color: "var(--text-primary)" };
const ENTRY_TITLE: CSSProperties = { fontSize: "14px", fontWeight: 700 };
const DATE: CSSProperties = { fontSize: "12px", color: "var(--text-secondary)", flexShrink: 0 };
const ENTRY_BODY: CSSProperties = { padding: "0 16px 14px", color: "var(--text-primary)", fontSize: "13px", lineHeight: 1.6 };
