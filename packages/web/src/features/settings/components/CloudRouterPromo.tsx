/**
 * CloudRouter promo block — three states on Settings → credentials card.
 * Design: design-spec-cloudrouter-promo-onboarding-v1.0.md
 */

import { useEffect, useState, type CSSProperties } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../shared/api/client.js";
import { i18n } from "../../../shared/i18n/index.js";
import { Icon } from "../../../shared/components/Icon.js";
import { theme } from "../../../shared/theme/index.js";

const CR_URL = "https://cloudrouter.online";

export function CloudRouterPromo() {
  const qc = useQueryClient();
  const [, tick] = useState(0);
  useEffect(() => {
    const u1 = i18n.onChange(() => tick((n) => n + 1));
    const u2 = theme.onChange(() => tick((n) => n + 1));
    return () => {
      u1();
      u2();
    };
  }, []);

  const { data, isLoading } = useQuery({
    queryKey: ["promo-cloudrouter"],
    queryFn: () => api.promo.cloudrouter.get(),
  });

  const claimMut = useMutation({
    mutationFn: () => api.promo.cloudrouter.claim(),
    onSuccess: (res) => {
      // Optimistically mirror claim/pool_empty into cache then refetch
      qc.setQueryData(["promo-cloudrouter"], (prev: any) => {
        if (!prev) return prev;
        if (res.pool_empty) return { ...prev, my_code: null, available: false };
        if (res.code) return { ...prev, my_code: res.code, available: prev.available };
        return prev;
      });
      void qc.invalidateQueries({ queryKey: ["promo-cloudrouter"] });
    },
  });

  const [copied, setCopied] = useState(false);
  const [toast, setToast] = useState("");

  if (isLoading || !data || data.enabled === false) return null;

  const myCode = data.my_code;
  const poolEmpty = !myCode && data.available === false;
  const dark = theme.current() === "dark";

  async function copyCode(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setToast(i18n.t("settings.creds.cloudRouter.copied"));
      setTimeout(() => setCopied(false), 1200);
      setTimeout(() => setToast(""), 2200);
    } catch {
      /* ignore */
    }
  }

  const shell: CSSProperties = {
    display: "flex",
    gap: 16,
    alignItems: "flex-start",
    flexWrap: "wrap",
    padding: "18px 20px",
    borderRadius: 12,
    marginBottom: 16,
    border: dark
      ? "1px solid rgba(129,140,248,0.35)"
      : "1px solid rgba(99,102,241,0.28)",
    background: dark
      ? "linear-gradient(120deg, rgba(76,29,149,0.28), rgba(30,58,138,0.24))"
      : "linear-gradient(120deg, #f5f3ff, #eff6ff)",
  };

  return (
    <div data-testid="cloudrouter-promo" style={shell}>
      <img
        src="/cloudrouter-logo.svg"
        alt="CloudRouter"
        width={44}
        height={44}
        style={{ flexShrink: 0, borderRadius: 10 }}
      />
      <div style={{ flex: 1, minWidth: 200 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: "var(--text-primary)" }}>
            {i18n.t("settings.creds.cloudRouter.title")}
          </span>
          <span
            style={{
              fontSize: 10,
              fontWeight: 600,
              padding: "2px 6px",
              borderRadius: 4,
              border: dark ? "1px solid rgba(165,180,252,0.5)" : "1px solid rgba(99,102,241,0.45)",
              color: dark ? "#a5b4fc" : "#4f46e5",
            }}
          >
            {i18n.t("settings.creds.cloudRouter.tag")}
          </span>
        </div>
        <p style={{ margin: "0 0 6px", fontSize: 12.5, color: "var(--text-secondary)", lineHeight: 1.5 }}>
          {i18n.t("settings.creds.cloudRouter.points")}
        </p>
        <p
          style={{
            margin: 0,
            fontSize: 12.5,
            fontWeight: 500,
            color: dark ? "#a5b4fc" : "#4338ca",
            lineHeight: 1.5,
          }}
        >
          {i18n.t("settings.creds.cloudRouter.sub")}
        </p>
      </div>

      <div style={{ flexShrink: 0, minWidth: 160, display: "flex", flexDirection: "column", gap: 8, alignItems: "stretch" }}>
        {myCode ? (
          <ClaimedPanel
            code={myCode}
            copied={copied}
            onCopy={() => void copyCode(myCode)}
            dark={dark}
          />
        ) : poolEmpty ? (
          <>
            <GoButton />
            <div
              data-testid="cloudrouter-pool-empty"
              style={{
                border: "1px dashed var(--border)",
                borderRadius: 8,
                padding: "10px 12px",
                fontSize: 12,
                color: "var(--text-secondary)",
                textAlign: "center",
                maxWidth: 210,
              }}
            >
              {i18n.t("settings.creds.cloudRouter.exhausted")}
            </div>
          </>
        ) : (
          <>
            <GoButton />
            <button
              type="button"
              data-testid="cloudrouter-claim-btn"
              disabled={claimMut.isPending}
              onClick={() => claimMut.mutate()}
              style={{
                height: 34,
                padding: "0 14px",
                borderRadius: 8,
                border: "1px solid #6366f1",
                background: "var(--bg-card)",
                color: "#6366f1",
                fontSize: 12,
                fontWeight: 600,
                cursor: claimMut.isPending ? "wait" : "pointer",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
              }}
            >
              🎁 {claimMut.isPending ? "…" : i18n.t("settings.creds.cloudRouter.claim")}
            </button>
            {claimMut.isError ? (
              <span style={{ fontSize: 11, color: "var(--brand)" }}>
                {claimMut.error instanceof Error ? claimMut.error.message : String(claimMut.error)}
              </span>
            ) : null}
          </>
        )}
      </div>

      {toast ? (
        <div
          data-testid="cloudrouter-toast"
          style={{
            position: "fixed",
            bottom: 32,
            left: "50%",
            transform: "translateX(-50%)",
            background: "rgba(0,0,0,0.9)",
            color: "#fff",
            padding: "8px 16px",
            borderRadius: 8,
            fontSize: 13,
            zIndex: 500,
          }}
        >
          {toast}
        </div>
      ) : null}
    </div>
  );
}

function GoButton() {
  return (
    <a
      href={CR_URL}
      target="_blank"
      rel="noopener noreferrer"
      data-testid="cloudrouter-go-btn"
      style={{
        height: 34,
        padding: "0 14px",
        borderRadius: 8,
        border: "none",
        background: "#6366f1",
        color: "#fff",
        fontSize: 12,
        fontWeight: 600,
        textDecoration: "none",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "#4f46e5";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "#6366f1";
      }}
    >
      {i18n.t("settings.creds.cloudRouter.go")} ↗
    </a>
  );
}

function ClaimedPanel({
  code,
  copied,
  onCopy,
  dark,
}: {
  code: string;
  copied: boolean;
  onCopy: () => void;
  dark: boolean;
}) {
  return (
    <div
      data-testid="cloudrouter-claimed"
      style={{
        minWidth: 250,
        padding: 12,
        borderRadius: 10,
        background: dark ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.72)",
        border: dark ? "1px solid rgba(255,255,255,0.1)" : "1px solid rgba(99,102,241,0.2)",
      }}
    >
      <div style={{ fontSize: 11, fontWeight: 600, color: dark ? "#a5b4fc" : "#4f46e5", marginBottom: 6 }}>
        {i18n.t("settings.creds.cloudRouter.claimedLabel")}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <code
          style={{
            fontFamily: "SF Mono, JetBrains Mono, monospace",
            fontSize: 15,
            fontWeight: 700,
            letterSpacing: "0.04em",
            color: "var(--text-primary)",
            flex: 1,
            wordBreak: "break-all",
          }}
        >
          {code}
        </code>
        <button
          type="button"
          data-testid="cloudrouter-copy-btn"
          onClick={onCopy}
          title={i18n.t("settings.creds.cloudRouter.copy")}
          style={{
            width: 26,
            height: 26,
            borderRadius: 6,
            border: "1px solid #6366f1",
            background: "transparent",
            color: "#6366f1",
            cursor: "pointer",
            display: "grid",
            placeItems: "center",
            flexShrink: 0,
          }}
        >
          <Icon name={copied ? "check" : "copy"} size={13} />
        </button>
      </div>
      <p style={{ margin: 0, fontSize: 11.5, color: "var(--text-secondary)", lineHeight: 1.5 }}>
        {i18n.t("settings.creds.cloudRouter.claimedGuideBefore")}
        <a
          href={CR_URL}
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: dark ? "#a5b4fc" : "#4f46e5", fontWeight: 700, textDecoration: "none" }}
        >
          CloudRouter
        </a>
        {i18n.t("settings.creds.cloudRouter.claimedGuideAfter")}
      </p>
    </div>
  );
}

/** Info bar when user has zero credentials — above promo block. */
export function CredentialsEmptyNotice({ onAdd }: { onAdd: () => void }) {
  const [, tick] = useState(0);
  useEffect(() => i18n.onChange(() => tick((n) => n + 1)), []);

  return (
    <div
      data-testid="credentials-empty-notice"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 14px",
        marginBottom: 12,
        borderRadius: 8,
        background: "rgba(37,99,235,0.08)",
        border: "1px solid rgba(37,99,235,0.22)",
        fontSize: 12.5,
        color: "var(--text-primary)",
      }}
    >
      <Icon name="info" size={15} style={{ color: "#2563eb", flexShrink: 0 }} />
      <span style={{ flex: 1 }}>{i18n.t("settings.creds.emptyNotice")}</span>
      <button
        type="button"
        data-testid="credentials-empty-add"
        onClick={onAdd}
        style={{
          height: 28,
          padding: "0 12px",
          border: "none",
          borderRadius: 6,
          background: "var(--brand)",
          color: "var(--btn-primary-text)",
          fontSize: 12,
          fontWeight: 600,
          cursor: "pointer",
          flexShrink: 0,
        }}
      >
        {i18n.t("settings.creds.emptyNoticeAdd")}
      </button>
    </div>
  );
}
