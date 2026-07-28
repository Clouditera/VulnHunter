/**
 * Generic session invalidation page for the business bundle.
 * Used when an admin session cookie is present on the business site.
 * Zero admin/console/port information — only logout.
 */
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../../shared/api/client.js";
import { i18n } from "../../../shared/i18n/index.js";
import { Icon } from "../../../shared/components/Icon.js";

export function SessionInvalidPage() {
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
      data-testid="session-invalid-page"
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
          width: 440,
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
            background: "var(--bg-page)",
            color: "var(--text-secondary)",
            display: "grid",
            placeItems: "center",
          }}
        >
          <Icon name="lock" size={28} />
        </div>
        <h1 style={{ margin: "0 0 10px", fontSize: 20, fontWeight: 700, color: "var(--text-primary)" }}>
          {i18n.t("session.invalidTitle")}
        </h1>
        <p style={{ margin: "0 0 24px", fontSize: 14, color: "var(--text-secondary)", lineHeight: 1.55 }}>
          {i18n.t("session.invalidBody")}
        </p>
        <button
          type="button"
          data-testid="session-invalid-logout"
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
          {i18n.t("nav.user.logout")}
        </button>
      </div>
    </div>
  );
}
