import { useState, useEffect } from "react";
import { i18n } from "../../../shared/i18n/index.js";

export function SettingsPage() {
  const [, forceUpdate] = useState(0);
  useEffect(() => i18n.onChange(() => forceUpdate((n) => n + 1)), []);

  return (
    <div data-testid="settings-page" style={{ padding: "40px", color: "var(--text-secondary)" }}>
      <h1 style={{ fontSize: "24px", fontWeight: 700, margin: "0 0 24px", color: "var(--text-primary)" }}>
        {i18n.t("settings.title")}
      </h1>
      <p>{i18n.t("placeholder.comingSoon")}</p>
    </div>
  );
}
