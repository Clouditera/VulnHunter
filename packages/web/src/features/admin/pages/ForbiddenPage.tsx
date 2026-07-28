import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../../shared/api/client.js";
import { i18n } from "../../../shared/i18n/index.js";
import { Icon } from "../../../shared/components/Icon.js";

/** Layout-free 403 for non-admin hitting /admin/* — always offer logout so user can switch account. */
export function ForbiddenPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();

  async function logout() {
    try {
      await api.auth.logout();
    } catch {
      /* ignore */
    }
    qc.clear();
    navigate("/login", { replace: true });
  }

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
          data-testid="admin-forbidden-logout"
          onClick={() => void logout()}
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
          {i18n.t("admin.forbidden.logout")}
        </button>
      </div>
    </div>
  );
}
