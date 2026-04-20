import { createBrowserRouter, Navigate, Outlet } from "react-router-dom";
import { useSystemStatus } from "../features/auth/hooks/useSystemStatus.js";
import { ActivatePage } from "../features/auth/pages/ActivatePage.js";
import { BootstrapPage } from "../features/auth/pages/BootstrapPage.js";
import { LoginPage } from "../features/auth/pages/LoginPage.js";
import { DashboardPage } from "../features/dashboard/pages/DashboardPage.js";
import { ExpiredPage } from "../features/auth/pages/ExpiredPage.js";

/** Root guard: reads /api/system/status and routes accordingly */
function RootGuard() {
  const { data: status, isLoading, error } = useSystemStatus();

  if (isLoading) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100vh",
          background: "var(--bg-page)",
          color: "var(--text-secondary)",
          fontSize: "14px",
        }}
      >
        Loading...
      </div>
    );
  }

  if (error || !status) {
    return <Navigate to="/activate" replace />;
  }

  if (status.license.status !== "active") {
    return <Navigate to="/activate" replace />;
  }

  if (!status.has_admin) {
    return <Navigate to="/bootstrap" replace />;
  }

  if (!status.is_authenticated) {
    return <Navigate to="/login" replace />;
  }

  return <Navigate to="/dashboard" replace />;
}

/** Require authenticated + active license */
function AuthGuard() {
  const { data: status, isLoading } = useSystemStatus();

  if (isLoading) return null;
  if (!status?.is_authenticated) return <Navigate to="/login" replace />;
  if (status.license.status !== "active") return <Navigate to="/activate" replace />;

  return <Outlet />;
}

export const router = createBrowserRouter([
  { path: "/", element: <RootGuard /> },
  { path: "/activate", element: <ActivatePage /> },
  { path: "/expired", element: <ExpiredPage /> },
  { path: "/bootstrap", element: <BootstrapPage /> },
  { path: "/login", element: <LoginPage /> },
  {
    element: <AuthGuard />,
    children: [
      { path: "/dashboard", element: <DashboardPage /> },
      // TODO: /tasks, /chat, /settings
    ],
  },
]);
