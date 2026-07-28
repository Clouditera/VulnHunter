import { useEffect, useState, type CSSProperties } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../shared/api/client.js";
import { i18n } from "../../shared/i18n/index.js";
import { theme } from "../../shared/theme/index.js";
import { Icon, type IconName } from "../../shared/components/Icon.js";
import { useSystemStatus } from "../auth/hooks/useSystemStatus.js";

const NAV: Array<{ to: string; icon: IconName; labelKey: string; testid: string }> = [
  { to: "/admin/users", icon: "users", labelKey: "admin.nav.users", testid: "admin-nav-users" },
  { to: "/admin/smtp", icon: "mail", labelKey: "admin.nav.smtp", testid: "admin-nav-smtp" },
  { to: "/admin/feedback", icon: "send", labelKey: "admin.nav.feedback", testid: "admin-nav-feedback" },
  { to: "/admin/system", icon: "sliders", labelKey: "admin.nav.system", testid: "admin-nav-system" },
  { to: "/admin/license", icon: "key", labelKey: "admin.nav.license", testid: "admin-nav-license" },
  { to: "/admin/credits", icon: "gift", labelKey: "admin.nav.credits", testid: "admin-nav-credits" },
];

export function AdminLayout() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: status } = useSystemStatus();
  const [, tick] = useState(0);
  useEffect(() => {
    const u1 = i18n.onChange(() => tick((n) => n + 1));
    const u2 = theme.onChange(() => tick((n) => n + 1));
    return () => {
      u1();
      u2();
    };
  }, []);

  const user = status?.user;
  const initial = (user?.displayName?.[0] || user?.email?.[0] || "A").toUpperCase();

  async function logout() {
    await api.auth.logout();
    qc.clear();
    navigate("/login");
  }

  return (
    <div
      data-testid="admin-layout"
      data-theme={theme.current()}
      style={{ display: "flex", height: "100vh", background: "var(--bg-page)", overflow: "hidden" }}
    >
      <nav
        data-testid="admin-sidebar"
        style={{
          width: 224,
          background: "var(--nav-bg)",
          display: "flex",
          flexDirection: "column",
          flexShrink: 0,
          height: "100vh",
          position: "sticky",
          top: 0,
        }}
      >
        <div style={{ padding: "18px 16px 12px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
            <div
              style={{
                width: 24,
                height: 24,
                borderRadius: 6,
                background: "var(--brand)",
                color: "#fff",
                fontSize: 13,
                fontWeight: 800,
                display: "grid",
                placeItems: "center",
              }}
            >
              V
            </div>
            <div style={{ fontSize: 14.5, fontWeight: 700, color: "#fff" }}>VulnHunter</div>
          </div>
          <div
            data-testid="admin-badge"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              padding: "3px 8px",
              borderRadius: 999,
              border: "1px solid rgba(220,38,38,0.55)",
              color: "#f87171",
              fontSize: 11,
              fontWeight: 600,
            }}
          >
            <Icon name="lock" size={11} />
            {i18n.t("admin.badge")}
          </div>
        </div>

        <div style={{ padding: "8px 10px", display: "flex", flexDirection: "column", gap: 2, flex: 1 }}>
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              data-testid={item.testid}
              style={({ isActive }) => ({
                display: "flex",
                alignItems: "center",
                gap: 10,
                height: 34,
                padding: "0 12px",
                borderRadius: 7,
                textDecoration: "none",
                color: isActive ? "#fff" : "rgba(255,255,255,0.55)",
                background: isActive ? "rgba(255,255,255,0.1)" : "transparent",
                fontSize: 13,
                fontWeight: isActive ? 600 : 500,
              })}
            >
              <Icon name={item.icon} size={17} />
              <span>{i18n.t(item.labelKey)}</span>
            </NavLink>
          ))}
        </div>

        <div style={{ padding: "12px 14px 18px", borderTop: "1px solid rgba(255,255,255,0.08)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
            <div
              style={{
                width: 28,
                height: 28,
                borderRadius: "50%",
                background: "var(--brand)",
                color: "#fff",
                fontSize: 12,
                fontWeight: 600,
                display: "grid",
                placeItems: "center",
              }}
            >
              {initial}
            </div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div
                style={{
                  fontSize: 12,
                  color: "rgba(255,255,255,0.85)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {user?.email ?? "—"}
              </div>
              <div style={{ fontSize: 11, color: "rgba(255,255,255,0.45)" }}>
                {i18n.t("admin.superAdmin")}
              </div>
            </div>
          </div>
          <button
            type="button"
            data-testid="admin-logout"
            onClick={() => void logout()}
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "8px 10px",
              border: "none",
              borderRadius: 8,
              background: "transparent",
              color: "rgba(255,255,255,0.7)",
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            <Icon name="logout" size={14} />
            {i18n.t("nav.user.logout")}
          </button>
        </div>
      </nav>

      <main style={{ flex: 1, minWidth: 0, overflow: "auto", height: "100vh" }}>
        <div style={{ maxWidth: 1080, margin: "0 auto", padding: "36px 40px" }}>
          <Outlet />
        </div>
      </main>
    </div>
  );
}

export function AdminPageHeader({
  page,
  title,
  desc,
}: {
  page: string;
  title: string;
  desc?: string;
}) {
  return (
    <header style={{ marginBottom: 28 }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: "var(--brand)",
          marginBottom: 8,
        }}
      >
        {i18n.t("admin.badge")} / {page}
      </div>
      <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: "var(--text-primary)" }}>{title}</h1>
      {desc ? (
        <p style={{ margin: "6px 0 0", fontSize: 13.5, color: "var(--text-secondary)" }}>{desc}</p>
      ) : null}
    </header>
  );
}

export const adminCardStyle: CSSProperties = {
  background: "var(--bg-card)",
  borderRadius: 12,
  padding: 24,
  border: "1px solid var(--border)",
  marginBottom: 16,
};
