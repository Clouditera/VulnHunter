import { i18n } from "../../../shared/i18n/index.js";
import { UsersSection } from "../../settings/components/UsersSection.js";
import { AdminPageHeader } from "../layout.js";

export function UsersPage() {
  return (
    <div data-testid="admin-users-page">
      <AdminPageHeader
        page={i18n.t("admin.nav.users")}
        title={i18n.t("admin.users.title")}
        desc={i18n.t("admin.users.desc")}
      />
      <div
        data-testid="admin-users-protect-hint"
        style={{
          display: "flex",
          gap: 10,
          padding: "12px 14px",
          marginBottom: 16,
          borderRadius: 8,
          background: "rgba(37,99,235,0.08)",
          border: "1px solid rgba(37,99,235,0.22)",
          color: "var(--text-primary)",
          fontSize: 13,
        }}
      >
        {i18n.t("admin.users.protectHint")}
      </div>
      <UsersSection />
    </div>
  );
}
