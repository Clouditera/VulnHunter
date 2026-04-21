import { useState, useEffect } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { api } from "../shared/api/client.js";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { i18n } from "../shared/i18n/index.js";
import { theme } from "../shared/theme/index.js";

const NAV_ITEMS = [
  { to: "/dashboard", icon: "📊", labelKey: "nav.dashboard", testid: "nav-dashboard" },
  { to: "/tasks", icon: "📋", labelKey: "nav.tasks", testid: "nav-tasks" },
  { to: "/chat", icon: "💬", labelKey: "nav.chat", testid: "nav-chat" },
  { to: "/settings", icon: "⚙️", labelKey: "nav.settings", testid: "nav-settings" },
];

export function AppLayout() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [, forceUpdate] = useState(0);

  // Subscribe to i18n + theme changes for re-render
  useEffect(() => {
    const unsub1 = i18n.onChange(() => forceUpdate((n) => n + 1));
    const unsub2 = theme.onChange(() => forceUpdate((n) => n + 1));
    return () => {
      unsub1();
      unsub2();
    };
  }, []);

  const currentTheme = theme.current();
  const currentLang = i18n.locale();

  async function handleLogout() {
    await api.auth.logout();
    qc.invalidateQueries({ queryKey: ["system-status"] });
    navigate("/login");
  }

  return (
    <div
      data-testid="app-layout"
      data-theme={currentTheme}
      style={{ display: "flex", minHeight: "100vh", background: "var(--bg-page)" }}
    >
      {/* Left nav */}
      <nav
        data-testid="nav-sidebar"
        style={{
          width: "68px",
          background: "var(--nav-bg)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          paddingTop: "16px",
          flexShrink: 0,
        }}
      >
        {/* Logo */}
        <div
          style={{
            width: "40px",
            height: "40px",
            borderRadius: "10px",
            background: "var(--brand)",
            color: "#fff",
            fontWeight: 800,
            fontSize: "18px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            marginBottom: "24px",
            flexShrink: 0,
          }}
        >
          V
        </div>

        {/* Nav items */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "4px" }}>
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              data-testid={item.testid}
              style={({ isActive }) => ({
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: "4px",
                padding: "8px 4px",
                borderRadius: "8px",
                textDecoration: "none",
                color: isActive ? "#fff" : "#a3a3a3",
                background: isActive ? "rgba(255,255,255,0.1)" : "transparent",
                width: "52px",
                fontSize: "10px",
                fontWeight: 500,
                transition: "all 0.15s",
              })}
            >
              <span style={{ fontSize: "18px" }}>{item.icon}</span>
              {i18n.t(item.labelKey)}
            </NavLink>
          ))}
        </div>

        {/* Bottom: lang/theme toggles + user */}
        <div
          data-testid="nav-bottom"
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: "8px",
            marginBottom: "16px",
          }}
        >
          {/* Language toggle */}
          <button
            data-testid="nav-lang-toggle"
            data-lang={currentLang}
            onClick={() => i18n.toggle()}
            style={{
              width: "32px",
              height: "32px",
              borderRadius: "6px",
              background: "transparent",
              border: "1px solid #444",
              color: "#a3a3a3",
              cursor: "pointer",
              fontSize: "10px",
              fontWeight: 600,
            }}
            title={currentLang === "zh" ? "切换到英文" : "Switch to 中文"}
          >
            {currentLang === "zh" ? "中" : "EN"}
          </button>

          {/* Theme toggle */}
          <button
            data-testid="nav-theme-toggle"
            data-theme={currentTheme}
            onClick={() => theme.toggle()}
            style={{
              width: "32px",
              height: "32px",
              borderRadius: "6px",
              background: "transparent",
              border: "1px solid #444",
              color: "#a3a3a3",
              cursor: "pointer",
              fontSize: "14px",
            }}
            title={currentTheme === "dark" ? "浅色模式 / Light mode" : "深色模式 / Dark mode"}
          >
            {currentTheme === "dark" ? "🌙" : "☀️"}
          </button>

          {/* User avatar + logout */}
          <button
            data-testid="nav-logout"
            onClick={handleLogout}
            style={{
              width: "32px",
              height: "32px",
              borderRadius: "50%",
              background: "#dc2626",
              color: "#fff",
              border: "none",
              cursor: "pointer",
              fontSize: "12px",
              fontWeight: 700,
            }}
            title={i18n.t("nav.logout")}
          >
            A
          </button>
        </div>
      </nav>

      {/* Main content */}
      <main style={{ flex: 1, overflow: "auto" }}>
        <Outlet />
      </main>
    </div>
  );
}
