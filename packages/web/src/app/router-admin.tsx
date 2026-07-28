import { createBrowserRouter, Navigate, Outlet } from "react-router-dom";
import { useSystemStatus } from "../features/auth/hooks/useSystemStatus.js";
import { ActivatePage } from "../features/auth/pages/ActivatePage.js";
import { BootstrapPage } from "../features/auth/pages/BootstrapPage.js";
import { LoginPage } from "../features/auth/pages/LoginPage.js";
import { ExpiredPage } from "../features/auth/pages/ExpiredPage.js";
import { ChangePasswordPage } from "../features/auth/pages/ChangePasswordPage.js";
import { AdminLayout } from "../features/admin/layout.js";
import { UsersPage } from "../features/admin/pages/UsersPage.js";
import { SmtpPage } from "../features/admin/pages/SmtpPage.js";
import { FeedbackPage } from "../features/admin/pages/FeedbackPage.js";
import { SystemPage } from "../features/admin/pages/SystemPage.js";
import { LicensePage } from "../features/admin/pages/LicensePage.js";
import { CreditsPage } from "../features/admin/pages/CreditsPage.js";
import { ForbiddenPage } from "../features/admin/pages/ForbiddenPage.js";

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

function RootGuard() {
  const { data: status, isLoading, error } = useSystemStatus();
  if (isLoading) return <LoadingScreen />;
  if (error || !status) return <Navigate to="/login" replace />;
  const target = licenseTarget(status);
  if (target) return <Navigate to={target} replace />;
  if (!status.has_admin) return <Navigate to="/bootstrap" replace />;
  if (status.is_authenticated) {
    if (status.user?.role === "admin") return <Navigate to="/admin" replace />;
    return <ForbiddenPage />;
  }
  return <Navigate to="/login" replace />;
}

function ActivateGuard() {
  const { data: status, isLoading } = useSystemStatus();
  if (isLoading) return <LoadingScreen />;
  if (status?.edition === "community" || status?.license.status === "active")
    return <Navigate to="/" replace />;
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
  if (status?.edition === "community" || status?.license.status === "active")
    return <Navigate to="/" replace />;
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
    if (status.is_authenticated && status.user?.role === "admin")
      return <Navigate to="/admin" replace />;
    return <Navigate to="/login" replace />;
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
  if (status.is_authenticated) {
    if (status.user?.role === "admin") return <Navigate to="/admin" replace />;
    return <ForbiddenPage />;
  }
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

function AdminRoleGuard() {
  const { data: status, isLoading } = useSystemStatus();
  if (isLoading) return <LoadingScreen />;
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
  {
    element: <AuthGuard />,
    children: [
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
  // Catch-all → admin home (or login)
  { path: "*", element: <Navigate to="/" replace /> },
]);
