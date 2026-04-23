import { createBrowserRouter, Navigate, Outlet } from "react-router-dom";
import { useSystemStatus } from "../features/auth/hooks/useSystemStatus.js";
import { ActivatePage } from "../features/auth/pages/ActivatePage.js";
import { BootstrapPage } from "../features/auth/pages/BootstrapPage.js";
import { LoginPage } from "../features/auth/pages/LoginPage.js";
import { ExpiredPage } from "../features/auth/pages/ExpiredPage.js";
import { AppLayout } from "./layout.js";
import { DashboardPage } from "../features/dashboard/pages/DashboardPage.js";
import { TasksListPage } from "../features/tasks/pages/TasksListPage.js";
import { TaskDetailPage } from "../features/tasks/pages/TaskDetailPage.js";
import { OverviewTab } from "../features/tasks/pages/tabs/OverviewTab.js";
import { FindingsTab } from "../features/tasks/pages/tabs/FindingsTab.js";
import { ReportsTab } from "../features/tasks/pages/tabs/ReportsTab.js";
import { WorkspaceTab } from "../features/tasks/pages/tabs/WorkspaceTab.js";
import { PocTab } from "../features/tasks/pages/tabs/PocTab.js";
import { WikiTab } from "../features/tasks/pages/tabs/WikiTab.js";
import { ChatPage } from "../features/chat/pages/ChatPage.js";
import { SettingsPage } from "../features/settings/pages/SettingsPage.js";

function RootGuard() {
  const { data: status, isLoading, error } = useSystemStatus();

  if (isLoading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", background: "var(--bg-page)", color: "var(--text-secondary)", fontSize: "14px" }}>
        Loading…
      </div>
    );
  }

  if (error || !status) return <Navigate to="/activate" replace />;
  if (status.license.status !== "active") return <Navigate to="/activate" replace />;
  if (!status.has_admin) return <Navigate to="/bootstrap" replace />;
  if (!status.is_authenticated) return <Navigate to="/login" replace />;
  return <Navigate to="/dashboard" replace />;
}

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
      {
        element: <AppLayout />,
        children: [
          { path: "/dashboard", element: <DashboardPage /> },
          { path: "/tasks", element: <TasksListPage /> },
          {
            path: "/tasks/:taskId",
            element: <TaskDetailPage />,
            children: [
              { index: true, element: <OverviewTab /> },
              { path: "findings", element: <FindingsTab /> },
              { path: "wiki", element: <WikiTab /> },
              { path: "reports", element: <ReportsTab /> },
              { path: "poc", element: <PocTab /> },
              { path: "workspace", element: <WorkspaceTab /> },
            ],
          },
          { path: "/chat", element: <ChatPage /> },
          { path: "/settings", element: <SettingsPage /> },
        ],
      },
    ],
  },
]);
