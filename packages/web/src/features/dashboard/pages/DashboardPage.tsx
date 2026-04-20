export function DashboardPage() {
  return (
    <div
      data-testid="dashboard-page"
      style={{
        padding: "40px",
        background: "var(--bg-page)",
        minHeight: "100vh",
      }}
    >
      <h1 style={{ fontSize: "24px", fontWeight: 700, margin: "0 0 24px" }}>Dashboard</h1>
      <p style={{ color: "var(--text-secondary)" }}>Welcome to VulnHunt. Tasks and stats coming soon.</p>
    </div>
  );
}
