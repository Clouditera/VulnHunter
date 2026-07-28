import { i18n } from "../../../shared/i18n/index.js";
import { FeedbackSection } from "../../settings/components/FeedbackSection.js";
import { AdminPageHeader } from "../layout.js";

export function FeedbackPage() {
  return (
    <div data-testid="admin-feedback-page">
      <AdminPageHeader
        page={i18n.t("admin.nav.feedback")}
        title={i18n.t("settings.feedback.title")}
        desc={i18n.t("settings.feedback.desc")}
      />
      <FeedbackSection />
    </div>
  );
}
