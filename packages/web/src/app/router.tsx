import { createBrowserRouter, Navigate, Outlet } from "react-router-dom";
import { useSystemStatus } from "../features/auth/hooks/useSystemStatus.js";
import { ActivatePage } from "../features/auth/pages/ActivatePage.js";
import { LoginPage } from "../features/auth/pages/LoginPage.js";
import { HomePage } from "../features/home/pages/HomePage.js";
import { ExpiredPage } from "../features/auth/pages/ExpiredPage.js";
import { ChangePasswordPage } from "../features/auth/pages/ChangePasswordPage.js";
import { AppLayout } from "./layout.js";
import { DashboardPage } from "../features/dashboard/pages/DashboardPage.js";
import { TasksListPage } from "../features/tasks/pages/TasksListPage.js";
import { TaskDetailPage } from "../features/tasks/pages/TaskDetailPage.js";
import { OverviewTab } from "../features/tasks/pages/tabs/OverviewTab.js";
import { FindingsTab } from "../features/tasks/pages/tabs/FindingsTab.js";
import { ReportsTab } from "../features/tasks/pages/tabs/ReportsTab.js";
import { WorkspaceTab } from "../features/tasks/pages/tabs/WorkspaceTab.js";
import { ExploitsTab } from "../features/tasks/pages/tabs/ExploitsTab.js";
import { WikiTab } from "../features/tasks/pages/tabs/WikiTab.js";
import { ChatPage } from "../features/chat/pages/ChatPage.js";
import { SettingsPage } from "../features/settings/pages/SettingsPage.js";
import { SessionInvalidPage } from "../features/auth/pages/SessionInvalidPage.js";

function RootGuard() {
  const { data: status, isLoading, error } = useSystemStatus();

  if (isLoading) return <LoadingScreen />;

  if (error || !status) return <HomePage />;
  if (status.edition !== "community") {
    if (status.license.status === "expired") return <Navigate to="/expired" replace />;
    if (status.license.status !== "active") return <Navigate to="/activate" replace />;
  }
  if (!status.has_admin) return goToAdminSetup(status);
  if (status.is_authenticated) {
    if (status.user?.role === "admin") return <SessionInvalidPage />;
    return <Navigate to="/chat" replace />;
  }
  return <HomePage />;
}

/**
 * First-run handoff (fish 2026-08-06, single-path onboarding): with NO admin
 * at all, the business site redirects to the admin-console setup wizard
 * (activate + create admin happen there). Port comes from the status payload
 * (admin_console_port); 23001 fallback for older backends. Returns null while
 * the browser navigates cross-port.
 */
function goToAdminSetup(status: { admin_console_port?: number }): null {
  const port = status.admin_console_port ?? 23001;
  window.location.replace(
    `${window.location.protocol}//${window.location.hostname}:${port}/setup`,
  );
  return null;
}

function LoadingScreen() {
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
      Loading…
    </div>
  );
}

function licenseTarget(status: ReturnType<typeof useSystemStatus>["data"]): string | null {
  if (!status || status.edition === "community") return null;
  if (status.license.status === "expired") return "/expired";
  if (status.license.status === "invalid" && status.license.invalid_reason === "version_mismatch")
    return "/expired";
  if (status.license.status !== "active") return "/activate";
  return null;
}

function postAuthHome(_status: NonNullable<ReturnType<typeof useSystemStatus>["data"]>): string {
  // Business bundle: admin sessions are invalid here (SessionInvalidPage via BusinessGuard)
  return "/chat";
}

function ActivateGuard() {
  const { data: status, isLoading } = useSystemStatus();
  if (isLoading) return <LoadingScreen />;
  if (status?.edition === "community" || status?.license.status === "active") return <Navigate to="/" replace />;
  if (
    status?.license.status === "expired" ||
    (status?.license.status === "invalid" && status.license.invalid_reason === "version_mismatch")
  )
    return <Navigate to="/expired" replace />;
  return <ActivatePage />;
}

function ExpiredGuard() {
  const { data: status, isLoading } = useSystemStatus();
  if (isLoading) return <LoadingScreen />;
  if (status?.edition === "community" || status?.license.status === "active") return <Navigate to="/" replace />;
  if (
    status?.license.status !== "expired" &&
    !(status?.license.status === "invalid" && status.license.invalid_reason === "version_mismatch")
  )
    return <Navigate to="/activate" replace />;
  return <ExpiredPage />;
}

function LoginGuard() {
  const { data: status, isLoading, error } = useSystemStatus();
  if (isLoading) return <LoadingScreen />;
  if (error || !status) return <Navigate to="/login" replace />;
  const target = licenseTarget(status);
  if (target) return <Navigate to={target} replace />;
  if (!status.has_admin) return goToAdminSetup(status);
  if (status.is_authenticated) return <Navigate to={postAuthHome(status)} replace />;
  return <LoginPage />;
}

function AuthGuard() {
  const { data: status, isLoading, error } = useSystemStatus();
  if (isLoading) return <LoadingScreen />;
  if (error || !status) return <Navigate to="/login" replace />;
  const target = licenseTarget(status);
  if (target) return <Navigate to={target} replace />;
  if (!status.has_admin) return goToAdminSetup(status);
  if (!status.is_authenticated) return <Navigate to="/login" replace />;
  return <Outlet />;
}

/** Business routes: admin sessions are not valid on the business site. */
function BusinessGuard() {
  const { data: status, isLoading } = useSystemStatus();
  if (isLoading) return <LoadingScreen />;
  if (status?.user?.role === "admin") return <SessionInvalidPage />;
  return <Outlet />;
}

export const router: ReturnType<typeof createBrowserRouter> = createBrowserRouter([
  { path: "/", element: <RootGuard /> },
  { path: "/activate", element: <ActivateGuard /> },
  { path: "/expired", element: <ExpiredGuard /> },
  {
    element: <AuthGuard />,
    children: [{ path: "/change-password", element: <ChangePasswordPage /> }],
  },
  { path: "/login", element: <LoginGuard /> },
  { path: "/home", element: <HomePage /> },
  {
    element: <AuthGuard />,
    children: [
      {
        element: <BusinessGuard />,
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
                  { path: "exploits", element: <ExploitsTab /> },
                  { path: "workspace", element: <WorkspaceTab /> },
                ],
              },
              { path: "/chat", element: <ChatPage /> },
              { path: "/settings", element: <SettingsPage /> },
            ],
          },
        ],
      },
    ],
  },
]);
