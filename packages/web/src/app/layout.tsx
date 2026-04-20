import { NavLink, Outlet } from "react-router-dom";
import { api } from "../shared/api/client.js";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";

const NAV_ITEMS = [
  { to: "/dashboard", icon: "📊", label: "Dashboard", testid: "nav-dashboard" },
  { to: "/tasks", icon: "📋", label: "Tasks", testid: "nav-tasks" },
  { to: "/chat", icon: "💬", label: "Chat", testid: "nav-chat" },
  { to: "/settings", icon: "⚙️", label: "Settings", testid: "nav-settings" },
];

export function AppLayout() {
  const navigate = useNavigate();
  const qc = useQueryClient();

  async function handleLogout() {
    await api.auth.logout();
    qc.invalidateQueries({ queryKey: ["system-status"] });
    navigate("/login");
  }

  return (
    <div style={{ display: "flex", minHeight: "100vh", background: "var(--bg-page)" }}>
      {/* Left nav */}
      <nav
        data-testid="sidebar-nav"
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
              {item.label}
            </NavLink>
          ))}
        </div>

        {/* Bottom: user */}
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
            marginBottom: "16px",
          }}
          title="Sign out"
        >
          A
        </button>
      </nav>

      {/* Main content */}
      <main style={{ flex: 1, overflow: "auto" }}>
        <Outlet />
      </main>
    </div>
  );
}
