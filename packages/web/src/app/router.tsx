import { createBrowserRouter, Navigate, Outlet } from "react-router-dom";
import { useSystemStatus } from "../features/auth/hooks/useSystemStatus.js";
import { ActivatePage } from "../features/auth/pages/ActivatePage.js";
import { BootstrapPage } from "../features/auth/pages/BootstrapPage.js";
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
import { AdminLayout } from "../features/admin/layout.js";
import { UsersPage } from "../features/admin/pages/UsersPage.js";
import { SmtpPage } from "../features/admin/pages/SmtpPage.js";
import { FeedbackPage } from "../features/admin/pages/FeedbackPage.js";
import { SystemPage } from "../features/admin/pages/SystemPage.js";
import { LicensePage } from "../features/admin/pages/LicensePage.js";
import { CreditsPage } from "../features/admin/pages/CreditsPage.js";
import { ForbiddenPage, AdminBusinessBlockedPage } from "../features/admin/pages/ForbiddenPage.js";
import { useServiceRole } from "../shared/hooks/useServiceRole.js";

function RootGuard() {
  const { data: status, isLoading, error } = useSystemStatus();

  if (isLoading) return <LoadingScreen />;

  if (error || !status) return <HomePage />;
  if (status.edition !== "community") {
    if (status.license.status === "expired") return <Navigate to="/expired" replace />;
    if (status.license.status !== "active") return <Navigate to="/activate" replace />;
  }
  if (!status.has_admin) return <Navigate to="/bootstrap" replace />;
  if (status.is_authenticated) {
    if (status.user?.role === "admin") return <Navigate to="/admin" replace />;
    return <Navigate to="/chat" replace />;
  }
  return <HomePage />;
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

function postAuthHome(status: NonNullable<ReturnType<typeof useSystemStatus>["data"]>): string {
  return status.user?.role === "admin" ? "/admin" : "/chat";
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

function BootstrapGuard() {
  const { data: status, isLoading, error } = useSystemStatus();
  if (isLoading) return <LoadingScreen />;
  if (error || !status) return <Navigate to="/login" replace />;
  const target = licenseTarget(status);
  if (target) return <Navigate to={target} replace />;
  if (status.has_admin) {
    if (status.is_authenticated) return <Navigate to={postAuthHome(status)} replace />;
    return <HomePage />;
  }
  return <BootstrapPage />;
}

function LoginGuard() {
  const { data: status, isLoading, error } = useSystemStatus();
  if (isLoading) return <LoadingScreen />;
  if (error || !status) return <Navigate to="/login" replace />;
  const target = licenseTarget(status);
  if (target) return <Navigate to={target} replace />;
  if (!status.has_admin) return <Navigate to="/bootstrap" replace />;
  if (status.is_authenticated) return <Navigate to={postAuthHome(status)} replace />;
  return <LoginPage />;
}

function AuthGuard() {
  const { data: status, isLoading, error } = useSystemStatus();
  if (isLoading) return <LoadingScreen />;
  if (error || !status) return <Navigate to="/login" replace />;
  const target = licenseTarget(status);
  if (target) return <Navigate to={target} replace />;
  if (!status.has_admin) return <Navigate to="/bootstrap" replace />;
  if (!status.is_authenticated) return <Navigate to="/login" replace />;
  return <Outlet />;
}

/** Business routes: never render on admin-web entry; admin users blocked on business entry. */
function BusinessGuard() {
  const { data: status, isLoading } = useSystemStatus();
  const { data: serviceRole, isLoading: roleLoading } = useServiceRole();
  if (isLoading || roleLoading) return <LoadingScreen />;
  // Admin entry must not show half-broken business UI — send everyone to /admin
  if (serviceRole === "admin") return <Navigate to="/admin" replace />;
  if (status?.user?.role === "admin") return <AdminBusinessBlockedPage />;
  return <Outlet />;
}

/** Admin console: only on admin-api entry; non-admin → 403; business entry → guide. */
function AdminRoleGuard() {
  const { data: status, isLoading } = useSystemStatus();
  const { data: serviceRole, isLoading: roleLoading } = useServiceRole();
  if (isLoading || roleLoading) return <LoadingScreen />;
  if (serviceRole === "business" || serviceRole === "unknown") return <AdminBusinessBlockedPage />;
  if (status?.user?.role !== "admin") return <ForbiddenPage />;
  return <Outlet />;
}

export const router = createBrowserRouter([
  { path: "/", element: <RootGuard /> },
  { path: "/activate", element: <ActivateGuard /> },
  { path: "/expired", element: <ExpiredGuard /> },
  {
    element: <AuthGuard />,
    children: [{ path: "/change-password", element: <ChangePasswordPage /> }],
  },
  { path: "/bootstrap", element: <BootstrapGuard /> },
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
      {
        element: <AdminRoleGuard />,
        children: [
          {
            path: "/admin",
            element: <AdminLayout />,
            children: [
              { index: true, element: <Navigate to="users" replace /> },
              { path: "users", element: <UsersPage /> },
              { path: "smtp", element: <SmtpPage /> },
              { path: "feedback", element: <FeedbackPage /> },
              { path: "system", element: <SystemPage /> },
              { path: "license", element: <LicensePage /> },
              { path: "credits", element: <CreditsPage /> },
            ],
          },
        ],
      },
    ],
  },
]);
