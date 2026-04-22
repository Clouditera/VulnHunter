import { useState, useEffect } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { api } from "../shared/api/client.js";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { i18n } from "../shared/i18n/index.js";
import { theme } from "../shared/theme/index.js";
import { Icon, type IconName } from "../shared/components/Icon.js";

const SIDEBAR_STATE_KEY = "vh.sidebar.expanded";
function loadSidebarExpanded(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_STATE_KEY) === "1";
  } catch {
    return false;
  }
}

const TOP_NAV_ITEMS: Array<{ to: string; icon: IconName; labelKey: string; testid: string }> = [
  { to: "/dashboard", icon: "dashboard", labelKey: "nav.dashboard", testid: "nav-dashboard" },
  { to: "/tasks", icon: "tasks", labelKey: "nav.tasks", testid: "nav-tasks" },
  { to: "/chat", icon: "chat", labelKey: "nav.chat", testid: "nav-chat" },
];

export function AppLayout() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [, forceUpdate] = useState(0);
  const [sidebarExpanded, setSidebarExpanded] = useState<boolean>(loadSidebarExpanded);

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_STATE_KEY, sidebarExpanded ? "1" : "0");
    } catch {}
  }, [sidebarExpanded]);

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
      style={{ display: "flex", height: "100vh", background: "var(--bg-page)", overflow: "hidden" }}
    >
      {/* Left nav — fixed height, bottom section always visible.
          Can be expanded (220px, horizontal labels) or collapsed (68px, icons + tiny labels below). */}
      <nav
        data-testid="nav-sidebar"
        data-expanded={sidebarExpanded || undefined}
        style={{
          width: sidebarExpanded ? "220px" : "68px",
          background: "var(--nav-bg)",
          display: "flex",
          flexDirection: "column",
          alignItems: sidebarExpanded ? "stretch" : "center",
          paddingTop: "16px",
          flexShrink: 0,
          height: "100vh",
          position: "sticky",
          top: 0,
          zIndex: 10,
          transition: "width 0.2s ease",
        }}
      >
        {/* Logo row (includes product name when expanded) */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "10px",
            padding: sidebarExpanded ? "0 14px" : "0",
            justifyContent: sidebarExpanded ? "flex-start" : "center",
            marginBottom: "24px",
            flexShrink: 0,
          }}
        >
          <div
            style={{
              width: "40px",
              height: "40px",
              borderRadius: "10px",
              background: "var(--brand)",
              color: "#fff",
              fontWeight: 800,
              fontSize: "20px",
              letterSpacing: "-1px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            V
          </div>
          {sidebarExpanded && (
            <span
              style={{
                fontSize: "15px",
                fontWeight: 700,
                color: "#fff",
                letterSpacing: "0.01em",
              }}
            >
              VulnHunt
            </span>
          )}
        </div>

        {/* Top nav items (Dashboard / Tasks / Chat) */}
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            gap: "4px",
            width: "100%",
            padding: "0 8px",
          }}
        >
          {TOP_NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              data-testid={item.testid}
              title={sidebarExpanded ? undefined : i18n.t(item.labelKey)}
              style={({ isActive }) => ({
                display: "flex",
                flexDirection: sidebarExpanded ? "row" : "column",
                alignItems: "center",
                justifyContent: sidebarExpanded ? "flex-start" : "center",
                gap: sidebarExpanded ? "12px" : "3px",
                padding: sidebarExpanded ? "10px 12px" : "10px 0",
                borderRadius: "6px",
                textDecoration: "none",
                color: isActive ? "#ffffff" : "#888",
                background: isActive
                  ? "rgba(255,255,255,0.1)"
                  : "transparent",
                fontSize: sidebarExpanded ? "13px" : "10px",
                fontWeight: 500,
                letterSpacing: "0.02em",
                transition: "all 0.15s",
              })}
            >
              <Icon name={item.icon} size={sidebarExpanded ? 18 : 20} />
              <span>{i18n.t(item.labelKey)}</span>
            </NavLink>
          ))}
        </div>

        {/* Bottom: settings / language / theme / avatar */}
        <div
          data-testid="nav-bottom"
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: "4px",
            padding: "0 8px 16px",
            width: "100%",
          }}
        >
          {/* Settings gear — moved from top nav to bottom (matches prototype) */}
          <NavLink
            to="/settings"
            data-testid="nav-settings"
            title={sidebarExpanded ? undefined : i18n.t("nav.settings")}
            style={({ isActive }) => ({
              display: "flex",
              flexDirection: sidebarExpanded ? "row" : "column",
              alignItems: "center",
              justifyContent: sidebarExpanded ? "flex-start" : "center",
              gap: sidebarExpanded ? "12px" : "3px",
              padding: sidebarExpanded ? "10px 12px" : "10px 0",
              borderRadius: "6px",
              textDecoration: "none",
              color: isActive ? "#ffffff" : "#888",
              background: isActive
                ? "rgba(255,255,255,0.1)"
                : "transparent",
              fontSize: sidebarExpanded ? "13px" : "10px",
              fontWeight: 500,
              letterSpacing: "0.02em",
              width: "100%",
              transition: "all 0.15s",
            })}
          >
            <Icon name="settings" size={sidebarExpanded ? 18 : 20} />
            <span>{i18n.t("nav.settings")}</span>
          </NavLink>
          {/* Expand/collapse toggle */}
          <button
            type="button"
            data-testid="nav-sidebar-toggle"
            onClick={() => setSidebarExpanded((v) => !v)}
            title={
              sidebarExpanded
                ? i18n.t("nav.sidebar.collapse")
                : i18n.t("nav.sidebar.expand")
            }
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: sidebarExpanded ? "flex-start" : "center",
              gap: sidebarExpanded ? "12px" : 0,
              padding: sidebarExpanded ? "10px 12px" : "10px 0",
              margin: "4px 0",
              width: "100%",
              border: "none",
              background: "transparent",
              color: "#888",
              cursor: "pointer",
              fontSize: "13px",
              fontWeight: 500,
              borderRadius: "6px",
              transition: "all 0.15s",
            }}
            onMouseEnter={(e) =>
              (e.currentTarget.style.background = "rgba(255,255,255,0.06)")
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.background = "transparent")
            }
          >
            <Icon
              name={sidebarExpanded ? "chevron-left" : "chevron-right"}
              size={sidebarExpanded ? 18 : 20}
            />
            {sidebarExpanded && <span>{i18n.t("nav.sidebar.collapse")}</span>}
          </button>

          {/* Language toggle — globe + locale badge */}
          <IconToggle
            testid="nav-lang-toggle"
            dataAttr={{ "data-lang": currentLang }}
            onClick={() => i18n.toggle()}
            title={currentLang === "zh" ? "Switch to English" : "切换到中文"}
            badge={currentLang === "zh" ? "中" : "EN"}
          >
            <Icon name="globe" size={18} />
          </IconToggle>

          {/* Theme toggle — sun/moon SVG */}
          <IconToggle
            testid="nav-theme-toggle"
            dataAttr={{ "data-theme": currentTheme }}
            onClick={() => theme.toggle()}
            title={currentTheme === "dark" ? "Switch to light" : "Switch to dark"}
          >
            <Icon name={currentTheme === "dark" ? "moon" : "sun"} size={18} />
          </IconToggle>

          {/* User avatar — click to logout */}
          <button
            data-testid="nav-logout"
            onClick={handleLogout}
            title={i18n.t("nav.logout")}
            style={{
              width: "32px",
              height: "32px",
              borderRadius: "50%",
              background: "#333",
              color: "#ccc",
              border: "none",
              cursor: "pointer",
              fontSize: "13px",
              fontWeight: 600,
              marginTop: "8px",
              transition: "background 0.15s",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "#444")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "#333")}
          >
            A
          </button>
        </div>
      </nav>

      {/* Main content — owns its own scroll so nav stays fixed */}
      <main style={{ flex: 1, overflow: "auto", height: "100vh" }}>
        <Outlet />
      </main>
    </div>
  );
}

/**
 * Small icon toggle button for nav bottom (language, theme).
 * 40×40 transparent, hover lightens, optional small corner badge.
 */
function IconToggle({
  children,
  onClick,
  title,
  testid,
  dataAttr,
  badge,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  testid: string;
  dataAttr?: Record<string, string>;
  badge?: string;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      data-testid={testid}
      {...dataAttr}
      onClick={onClick}
      title={title}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: "relative",
        width: "40px",
        height: "40px",
        borderRadius: "8px",
        background: hover ? "rgba(255,255,255,0.08)" : "transparent",
        border: "none",
        color: hover ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.6)",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        transition: "all 0.15s",
      }}
    >
      {children}
      {badge && (
        <span
          style={{
            position: "absolute",
            right: 4,
            bottom: 4,
            minWidth: "14px",
            height: "14px",
            padding: "0 3px",
            borderRadius: "7px",
            background: "var(--brand)",
            color: "#fff",
            fontSize: "9px",
            fontWeight: 700,
            letterSpacing: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            lineHeight: 1,
          }}
        >
          {badge}
        </span>
      )}
    </button>
  );
}
