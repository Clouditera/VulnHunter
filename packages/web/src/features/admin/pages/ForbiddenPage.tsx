import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../../shared/api/client.js";
import { i18n } from "../../../shared/i18n/index.js";
import { Icon } from "../../../shared/components/Icon.js";

/** Layout-free 403 for non-admin hitting /admin/* */
export function ForbiddenPage() {
  const navigate = useNavigate();
  return (
    <div
      data-testid="admin-forbidden-page"
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        background: "var(--bg-page)",
        padding: 24,
      }}
    >
      <div
        style={{
          width: 520,
          maxWidth: "100%",
          background: "var(--bg-card)",
          border: "1px solid var(--border)",
          borderRadius: 14,
          padding: "36px 32px",
          textAlign: "center",
        }}
      >
        <div
          style={{
            width: 56,
            height: 56,
            borderRadius: 14,
            margin: "0 auto 16px",
            background: "var(--brand-soft)",
            color: "var(--brand)",
            display: "grid",
            placeItems: "center",
          }}
        >
          <Icon name="shield-alert" size={28} />
        </div>
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: "0.08em",
            color: "var(--text-secondary)",
            marginBottom: 8,
          }}
        >
          403 · FORBIDDEN
        </div>
        <h1 style={{ margin: "0 0 10px", fontSize: 20, fontWeight: 700 }}>{i18n.t("admin.forbidden.title")}</h1>
        <p style={{ margin: "0 0 20px", fontSize: 14, color: "var(--text-secondary)", lineHeight: 1.55 }}>
          {i18n.t("admin.forbidden.body")}
        </p>
        <button
          type="button"
          data-testid="admin-forbidden-home"
          onClick={() => navigate("/chat")}
          style={{
            padding: "10px 18px",
            border: "none",
            borderRadius: 8,
            background: "var(--brand)",
            color: "var(--btn-primary-text)",
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          {i18n.t("admin.forbidden.home")}
        </button>
      </div>
    </div>
  );
}

/** Shown when an admin account hits the main business app */
export function AdminBusinessBlockedPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  async function logout() {
    try { await api.auth.logout(); } catch { /* ignore */ }
    qc.clear();
    navigate("/login");
  }
  return (
    <div
      data-testid="admin-business-blocked"
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        background: "var(--bg-page)",
        padding: 24,
      }}
    >
      <div
        style={{
          width: 520,
          maxWidth: "100%",
          background: "var(--bg-card)",
          border: "1px solid var(--border)",
          borderRadius: 14,
          padding: "36px 32px",
          textAlign: "center",
        }}
      >
        <div
          style={{
            width: 56,
            height: 56,
            borderRadius: 14,
            margin: "0 auto 16px",
            background: "var(--brand-soft)",
            color: "var(--brand)",
            display: "grid",
            placeItems: "center",
          }}
        >
          <Icon name="lock" size={28} />
        </div>
        <h1 style={{ margin: "0 0 10px", fontSize: 20, fontWeight: 700 }}>
          {i18n.t("admin.businessBlocked.title")}
        </h1>
        <p style={{ margin: "0 0 12px", fontSize: 14, color: "var(--text-secondary)", lineHeight: 1.55 }}>
          {i18n.t("admin.businessBlocked.body")}
        </p>
        <code
          style={{
            display: "block",
            margin: "0 auto 20px",
            padding: "10px 12px",
            borderRadius: 8,
            background: "var(--bg-page)",
            border: "1px solid var(--border)",
            fontSize: 12,
            textAlign: "left",
            whiteSpace: "pre-line",
          }}
        >
          {i18n.t("admin.businessBlocked.hint")}
        </code>
        <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
          <button
            type="button"
            data-testid="go-admin-console"
            onClick={() => {
              // Prefer same-host admin port; operator may use ssh -L
              const url = `${window.location.protocol}//${window.location.hostname}:23001/admin`;
              window.location.href = url;
            }}
            style={{
              padding: "10px 18px",
              border: "none",
              borderRadius: 8,
              background: "var(--brand)",
              color: "var(--btn-primary-text)",
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {i18n.t("admin.businessBlocked.openAdmin")}
          </button>
          <button
            type="button"
            onClick={() => void logout()}
            style={{
              padding: "10px 18px",
              border: "1px solid var(--border)",
              borderRadius: 8,
              background: "var(--bg-card)",
              color: "var(--text-primary)",
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            {i18n.t("nav.user.logout")}
          </button>
        </div>
      </div>
    </div>
  );
}
