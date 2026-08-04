/** Settings page shell: sub-nav + section composition. */
import { useEffect, useState } from "react";
import { i18n } from "../../../shared/i18n/index.js";
import { theme as themeStore } from "../../../shared/theme/index.js";
import { Icon } from "../../../shared/components/Icon.js";
import { SkillsSection } from "../components/SkillsSection.js";
import { ApiTokensSection } from "../components/ApiTokensSection.js";
import { ProfileSection } from "../components/ProfileSection.js";
import { CredentialsSection } from "../components/CredentialsSection.js";
import { SettingsCard, Field, SegGroup } from "../components/settings-ui.js";
import { useSystemStatus } from "../../auth/hooks/useSystemStatus.js";

export function SettingsPage() {
  const [, force] = useState(0);
  useEffect(() => i18n.onChange(() => force((n) => n + 1)), []);
  useEffect(() => themeStore.onChange(() => force((n) => n + 1)), []);

  const { isLoading: loading } = useSystemStatus();
  const isDark = themeStore.current() === "dark";

  const SUB_NAV_SECTIONS: Array<{ id: string; labelKey: string }> = [
    { id: "profile", labelKey: "settings.nav.profile" },
    { id: "credentials", labelKey: "settings.nav.credentials" },
    { id: "skills", labelKey: "settings.nav.skills" },
    { id: "tokens", labelKey: "settings.nav.tokens" },
    { id: "appearance", labelKey: "settings.nav.appearance" },
  ];
  return (
    <div
      data-testid="settings-page"
      style={{
        display: "flex",
        gap: "32px",
        maxWidth: 1120,
        margin: "0 auto",
        padding: "40px 24px",
        alignItems: "flex-start",
      }}
    >
      {/* Left sub-nav (sticky). Only shown when page content is loaded
          so the nav doesn't tease sections that aren't rendered yet. */}
      {!loading && (
        <aside
          data-testid="settings-subnav"
          style={{
            position: "sticky",
            top: "40px",
            width: "180px",
            flexShrink: 0,
            display: "flex",
            flexDirection: "column",
            gap: "2px",
            paddingTop: "6px",
          }}
        >
          <div
            style={{
              fontSize: "11px",
              fontWeight: 600,
              color: "var(--text-secondary)",
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              padding: "8px 10px",
            }}
          >
            {i18n.t("settings.title")}
          </div>
          {SUB_NAV_SECTIONS.map((s) => (
            <a
              key={s.id}
              href={`#${s.id}`}
              data-testid={`settings-subnav-${s.id}`}
              onClick={(e) => {
                e.preventDefault();
                const el = document.getElementById(s.id);
                if (el)
                  el.scrollIntoView({ behavior: "smooth", block: "start" });
                history.replaceState(null, "", `#${s.id}`);
              }}
              style={{
                display: "block",
                padding: "8px 10px",
                fontSize: "13px",
                fontWeight: 500,
                color: "var(--text-primary)",
                textDecoration: "none",
                borderRadius: "6px",
                borderLeft: "2px solid transparent",
                transition: "all 0.12s",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLAnchorElement).style.background =
                  "var(--bg-hover)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLAnchorElement).style.background =
                  "transparent";
              }}
            >
              {i18n.t(s.labelKey)}
            </a>
          ))}
        </aside>
      )}

      <div style={{ flex: 1, minWidth: 0, maxWidth: "880px" }}>
      <h1
        style={{
          fontSize: "24px",
          fontWeight: 700,
          margin: "0 0 4px",
          color: "var(--text-primary)",
        }}
      >
        {i18n.t("settings.title")}
      </h1>
      <p
        style={{
          fontSize: "14px",
          color: "var(--text-secondary)",
          margin: "0 0 28px",
        }}
      >
        {i18n.t("settings.subtitle")}
      </p>

      {loading ? (
        <div style={{ padding: "60px 0", textAlign: "center", color: "var(--text-secondary)" }}>
          {i18n.t("settings.loading")}
        </div>
      ) : (
        <>
          {/* Profile */}
          <div id="profile" style={{ scrollMarginTop: "20px" }} />
          <ProfileSection />

          {/* ============================================================= */}
          {/*  License Information (admin only)                              */}
          {/* ============================================================= */}


          {/* Credentials — unified list + inline editor */}
          <CredentialsSection />

          <div id="skills" style={{ scrollMarginTop: "20px" }} />
          <SkillsSection />

          <div id="tokens" style={{ scrollMarginTop: "20px" }} />
          <ApiTokensSection />

          <div id="appearance" style={{ scrollMarginTop: "20px" }} />
          <SettingsCard
            icon="globe"
            title={i18n.t("settings.appearance.title")}
            desc={i18n.t("settings.appearance.desc")}
            testid="settings-card-appearance"
          >
            <Field
              label={i18n.t("settings.appearance.langLabel")}
              hint={i18n.t("settings.appearance.langHint")}
            >
              <SegGroup
                testid="settings-lang-seg"
                value={i18n.locale() as "zh" | "en"}
                onChange={(v) => i18n.setLocale(v)}
                items={[
                  { value: "en", label: "English" },
                  { value: "zh", label: "中文" },
                ]}
              />
            </Field>

            <Field label={i18n.t("settings.appearance.themeLabel")}>
              <SegGroup
                testid="settings-theme-seg"
                value={isDark ? "dark" : "light"}
                onChange={(v) => themeStore.set(v)}
                items={[
                  {
                    value: "light",
                    label: (
                      <>
                        <Icon name="sun" size={14} />
                        <span>{i18n.t("nav.theme.light")}</span>
                      </>
                    ),
                  },
                  {
                    value: "dark",
                    label: (
                      <>
                        <Icon name="moon" size={14} />
                        <span>{i18n.t("nav.theme.dark")}</span>
                      </>
                    ),
                  },
                ]}
              />
            </Field>
          </SettingsCard>

        </>
      )}
      </div>
    </div>
  );
}
