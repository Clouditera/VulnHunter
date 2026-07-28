/**
 * First-run onboarding modal + reopen entry.
 * Seen flag: server users.onboarding_dismissed_at via status / PATCH /me.
 */

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../shared/api/client.js";
import { i18n } from "../../shared/i18n/index.js";
import { Icon } from "../../shared/components/Icon.js";
import { useSystemStatus } from "../auth/hooks/useSystemStatus.js";

export function OnboardingModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const startRef = useRef<HTMLButtonElement>(null);
  const [, tick] = useState(0);
  useEffect(() => i18n.onChange(() => tick((n) => n + 1)), []);

  useEffect(() => {
    if (!open) return;
    startRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        void dismiss();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function dismiss() {
    try {
      await api.auth.updateMe({ onboarding_dismissed: true });
      await qc.invalidateQueries({ queryKey: ["system-status"] });
    } catch {
      /* still close UI */
    }
    onClose();
  }

  if (!open) return null;

  return (
    <div
      data-testid="onboarding-modal"
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1200,
        background: "rgba(15,15,20,0.45)",
        display: "grid",
        placeItems: "center",
        padding: 24,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) void dismiss();
      }}
    >
      <div
        style={{
          width: 520,
          maxWidth: "100%",
          background: "var(--bg-card)",
          border: "1px solid var(--border)",
          borderRadius: 14,
          boxShadow: "0 16px 48px rgba(0,0,0,0.18)",
          overflow: "hidden",
        }}
      >
        <div style={{ padding: "22px 24px 8px", position: "relative" }}>
          <button
            type="button"
            data-testid="onboarding-close"
            aria-label="close"
            onClick={() => void dismiss()}
            style={{
              position: "absolute",
              top: 14,
              right: 14,
              width: 28,
              height: 28,
              border: "none",
              borderRadius: 6,
              background: "transparent",
              color: "var(--text-secondary)",
              cursor: "pointer",
              display: "grid",
              placeItems: "center",
            }}
          >
            <Icon name="x" size={16} />
          </button>
          <h2 style={{ margin: "0 0 6px", fontSize: 18, fontWeight: 700, color: "var(--text-primary)" }}>
            {i18n.t("onboarding.title")}
          </h2>
          <p style={{ margin: 0, fontSize: 13.5, color: "var(--text-secondary)" }}>
            {i18n.t("onboarding.sub")}
          </p>
        </div>

        <div style={{ padding: "12px 24px 8px", display: "flex", flexDirection: "column", gap: 10 }}>
          <Step
            n={1}
            icon="key"
            title={i18n.t("onboarding.step1Title")}
            body={i18n.t("onboarding.step1Body")}
          />
          <Step
            n={2}
            icon="target"
            title={i18n.t("onboarding.step2Title")}
            body={i18n.t("onboarding.step2Body")}
          />
        </div>

        <div
          style={{
            padding: "14px 24px 20px",
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
          }}
        >
          <span style={{ flex: 1, fontSize: 11.5, color: "var(--text-secondary)" }}>
            {i18n.t("onboarding.reopenHint")}
          </span>
          <button
            type="button"
            data-testid="onboarding-skip"
            onClick={() => void dismiss()}
            style={ghostBtn}
          >
            {i18n.t("onboarding.skip")}
          </button>
          <button
            ref={startRef}
            type="button"
            data-testid="onboarding-start"
            onClick={() => void dismiss()}
            style={primaryBtn}
          >
            {i18n.t("onboarding.start")}
          </button>
        </div>
      </div>
    </div>
  );
}

function Step({
  n,
  icon,
  title,
  body,
}: {
  n: number;
  icon: "key" | "target";
  title: string;
  body: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        gap: 12,
        padding: 14,
        borderRadius: 10,
        background: "var(--bg-page)",
        border: "1px solid var(--border)",
      }}
    >
      <div
        style={{
          width: 36,
          height: 36,
          borderRadius: "50%",
          background: "var(--brand)",
          color: "#fff",
          display: "grid",
          placeItems: "center",
          flexShrink: 0,
        }}
        aria-hidden
      >
        <Icon name={icon} size={16} />
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 700, color: "var(--text-primary)", marginBottom: 4 }}>
          {n === 1 ? "①" : "②"} {title}
        </div>
        <div style={{ fontSize: 12.5, color: "var(--text-secondary)", lineHeight: 1.55 }}>{body}</div>
      </div>
    </div>
  );
}

/** Host that auto-opens onboarding once after login when not dismissed. */
export function OnboardingHost() {
  const { data: status, isLoading } = useSystemStatus();
  const [open, setOpen] = useState(false);
  const [manual, setManual] = useState(false);

  useEffect(() => {
    if (isLoading || !status?.is_authenticated) return;
    if (status.user?.role === "admin") return;
    if (status.user?.onboarding_dismissed) return;
    setOpen(true);
  }, [isLoading, status?.is_authenticated, status?.user?.role, status?.user?.onboarding_dismissed]);

  // Expose reopen via custom event from sidebar
  useEffect(() => {
    const onReopen = () => {
      setManual(true);
      setOpen(true);
    };
    window.addEventListener("vh:open-onboarding", onReopen);
    return () => window.removeEventListener("vh:open-onboarding", onReopen);
  }, []);

  if (!open && !manual) return null;
  if (!open) return null;

  return (
    <OnboardingModal
      open={open}
      onClose={() => {
        setOpen(false);
        setManual(false);
      }}
    />
  );
}

const ghostBtn: CSSProperties = {
  height: 34,
  padding: "0 14px",
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "transparent",
  color: "var(--text-primary)",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
};

const primaryBtn: CSSProperties = {
  height: 34,
  padding: "0 16px",
  borderRadius: 8,
  border: "none",
  background: "var(--brand)",
  color: "var(--btn-primary-text)",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
};
