import { i18n } from "../../../shared/i18n/index.js";
import { SmtpSection } from "../../settings/components/SmtpSection.js";
import { AdminPageHeader } from "../layout.js";

export function SmtpPage() {
  return (
    <div data-testid="admin-smtp-page">
      <AdminPageHeader
        page={i18n.t("admin.nav.smtp")}
        title={i18n.t("settings.smtp.title")}
        desc={i18n.t("settings.smtp.desc")}
      />
      <SmtpSection />
    </div>
  );
}
