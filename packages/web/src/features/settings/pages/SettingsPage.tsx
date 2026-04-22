import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { CSSProperties } from "react";
import type { SystemStatus } from "@vulnhunt/shared";
import { i18n } from "../../../shared/i18n/index.js";
import { theme as themeStore } from "../../../shared/theme/index.js";
import { Icon, type IconName } from "../../../shared/components/Icon.js";
import { api, type LlmCredential, type SystemConfig } from "../../../shared/api/client.js";

/* -------------------------------------------------------------------------- */
/*  Design tokens mirroring the prototype.                                    */
/* -------------------------------------------------------------------------- */

const CARD: CSSProperties = {
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: "12px",
  padding: "24px",
  marginBottom: "16px",
};

const FIELD_LABEL: CSSProperties = {
  display: "block",
  fontSize: "11px",
  fontWeight: 600,
  textTransform: "uppercase",
  color: "var(--text-secondary)",
  marginBottom: "6px",
  letterSpacing: "0.04em",
};

const FIELD_INPUT: CSSProperties = {
  display: "block",
  width: "100%",
  height: "40px",
  padding: "0 12px",
  border: "1px solid var(--border)",
  borderRadius: "8px",
  fontSize: "14px",
  color: "var(--text-primary)",
  background: "var(--bg-card)",
  outline: "none",
  transition: "border-color 0.15s",
  fontFamily: "inherit",
  boxSizing: "border-box",
};

const FIELD_HINT: CSSProperties = {
  fontSize: "12px",
  color: "var(--text-secondary)",
  marginTop: "4px",
  opacity: 0.85,
  margin: "4px 0 0",
};

/* -------------------------------------------------------------------------- */
/*  Small building blocks                                                     */
/* -------------------------------------------------------------------------- */

function SettingsCard({
  icon,
  title,
  desc,
  children,
  testid,
}: {
  icon: IconName;
  title: string;
  desc: string;
  children: ReactNode;
  testid?: string;
}) {
  return (
    <section style={CARD} data-testid={testid}>
      <h3
        style={{
          fontSize: "15px",
          fontWeight: 600,
          margin: "0 0 4px",
          display: "flex",
          alignItems: "center",
          gap: "8px",
          color: "var(--text-primary)",
        }}
      >
        <Icon name={icon} size={18} style={{ color: "var(--text-secondary)" }} />
        <span>{title}</span>
      </h3>
      <p
        style={{
          fontSize: "13px",
          color: "var(--text-secondary)",
          opacity: 0.85,
          margin: "0 0 20px",
        }}
      >
        {desc}
      </p>
      {children}
    </section>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div style={{ marginBottom: "18px" }}>
      {label ? <label style={FIELD_LABEL}>{label}</label> : null}
      {children}
      {hint ? <p style={FIELD_HINT}>{hint}</p> : null}
    </div>
  );
}

function SegGroup<T extends string>({
  items,
  value,
  onChange,
  testid,
}: {
  items: Array<{ value: T; label: ReactNode }>;
  value: T;
  onChange: (v: T) => void;
  testid?: string;
}) {
  return (
    <div
      role="radiogroup"
      data-testid={testid}
      style={{
        display: "inline-flex",
        gap: 0,
        border: "1px solid var(--border)",
        borderRadius: "8px",
        padding: "3px",
        background: "var(--bg-page)",
      }}
    >
      {items.map((it) => {
        const active = it.value === value;
        return (
          <button
            key={it.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(it.value)}
            data-seg-value={it.value}
            data-active={active || undefined}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              padding: "6px 16px",
              fontSize: "13px",
              fontWeight: active ? 600 : 500,
              color: active ? "var(--text-primary)" : "var(--text-secondary)",
              background: active ? "var(--bg-card)" : "transparent",
              border: "none",
              borderRadius: "6px",
              cursor: "pointer",
              transition: "all 0.15s",
              boxShadow: active ? "0 1px 2px rgba(0,0,0,0.08)" : "none",
              lineHeight: 1,
            }}
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  The page                                                                  */
/* -------------------------------------------------------------------------- */

const PROVIDERS: Array<{ value: string; proto: string; label: string; defaultModel: string }> = [
  { value: "anthropic", proto: "anthropic", label: "Anthropic", defaultModel: "claude-sonnet-4-5" },
  { value: "openai", proto: "openai", label: "OpenAI", defaultModel: "gpt-4o" },
  { value: "minimax", proto: "openai", label: "MiniMax", defaultModel: "minimax-m2.5" },
  { value: "custom", proto: "openai", label: "Custom (OpenAI-compat)", defaultModel: "" },
];

const THINKING_VALUES = ["off", "minimal", "low", "medium", "high"] as const;
type ThinkingValue = (typeof THINKING_VALUES)[number];

function licenseStatusLabel(s: string | undefined): string {
  if (!s) return i18n.t("common.noData");
  return i18n.t(`settings.license.status.${s}`);
}

function licenseStatusColor(s: string | undefined): { bg: string; fg: string; dot: string } {
  switch (s) {
    case "active":
      return { bg: "var(--bg-success)", fg: "var(--bg-success-text)", dot: "#16a34a" };
    case "expired":
      return { bg: "var(--bg-error)", fg: "#991b1b", dot: "#dc2626" };
    case "invalid":
      return { bg: "var(--bg-error)", fg: "#991b1b", dot: "#dc2626" };
    default:
      return { bg: "var(--bg-warning)", fg: "#9a3412", dot: "#ea580c" };
  }
}

export function SettingsPage() {
  const [, force] = useState(0);
  useEffect(() => i18n.onChange(() => force((n) => n + 1)), []);
  useEffect(() => themeStore.onChange(() => force((n) => n + 1)), []);

  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [cred, setCred] = useState<LlmCredential | null>(null);
  const [config, setConfig] = useState<SystemConfig | null>(null);
  const [loading, setLoading] = useState(true);

  const [provider, setProvider] = useState<string>("anthropic");
  const [protoType, setProtoType] = useState<string>("anthropic");
  const [baseUrl, setBaseUrl] = useState<string>("");
  const [modelId, setModelId] = useState<string>("");
  const [thinking, setThinking] = useState<ThinkingValue>("medium");
  const [apiKey, setApiKey] = useState<string>("");
  const [showKey, setShowKey] = useState(false);

  const [maxParallel, setMaxParallel] = useState<number>(3);

  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);

  useEffect(() => {
    let mounted = true;
    Promise.all([
      api.system.status().catch(() => null),
      api.settings.getCredential().catch(() => ({ credential: null as LlmCredential | null })),
      api.settings.getSystemConfig().catch(() => null as { config: SystemConfig } | null),
    ]).then(([s, credResp, cfg]) => {
      if (!mounted) return;
      if (s) setStatus(s);
      if (credResp?.credential) {
        const c = credResp.credential;
        setCred(c);
        setProvider(c.provider);
        setProtoType(c.proto_type);
        setBaseUrl(c.base_url ?? "");
        setModelId(c.model_id);
        setThinking((c.thinking_effort as ThinkingValue) ?? "medium");
      } else {
        setModelId(PROVIDERS[0].defaultModel);
      }
      if (cfg?.config) {
        setConfig(cfg.config);
        setMaxParallel(cfg.config.max_parallel_scan);
      }
      setLoading(false);
    });
    return () => {
      mounted = false;
    };
  }, []);

  const dirty = useMemo(() => {
    const credChanged =
      apiKey.length > 0 ||
      (cred &&
        (cred.provider !== provider ||
          cred.proto_type !== protoType ||
          (cred.base_url ?? "") !== baseUrl ||
          cred.model_id !== modelId ||
          cred.thinking_effort !== thinking)) ||
      (!cred && (apiKey.length > 0 || modelId.length > 0));
    const cfgChanged = config ? config.max_parallel_scan !== maxParallel : false;
    return Boolean(credChanged) || cfgChanged;
  }, [apiKey, cred, provider, protoType, baseUrl, modelId, thinking, config, maxParallel]);

  const canSaveCred = apiKey.length > 0 || Boolean(cred);

  async function handleSave() {
    if (saving) return;
    setSaving(true);
    setToast(null);
    try {
      const ops: Array<Promise<unknown>> = [];

      const credChangedNoKey =
        cred &&
        apiKey.length === 0 &&
        (cred.provider !== provider ||
          cred.proto_type !== protoType ||
          (cred.base_url ?? "") !== baseUrl ||
          cred.model_id !== modelId ||
          cred.thinking_effort !== thinking);

      if (apiKey.length > 0) {
        ops.push(
          api.settings.saveCredential({
            provider,
            proto_type: protoType,
            base_url: baseUrl || undefined,
            model_id: modelId,
            thinking_effort: thinking,
            api_key: apiKey,
          }),
        );
      } else if (credChangedNoKey) {
        // Backend requires api_key on PUT; surface clearly.
        throw new Error("NEEDS_API_KEY");
      }

      if (config && config.max_parallel_scan !== maxParallel) {
        ops.push(api.settings.updateSystemConfig({ max_parallel_scan: maxParallel }));
      }

      if (ops.length === 0) {
        setSaving(false);
        return;
      }

      await Promise.all(ops);

      // Refresh credential state so UI shows "saved" masked view.
      const fresh = await api.settings.getCredential().catch(() => ({ credential: cred }));
      if (fresh?.credential) setCred(fresh.credential);
      if (config) setConfig({ ...config, max_parallel_scan: maxParallel });
      setApiKey("");
      setToast({ kind: "ok", msg: i18n.t("settings.savedToast") });
      setTimeout(() => setToast(null), 2200);
    } catch (err) {
      const code = (err as Error)?.message ?? "";
      const msg =
        code === "NEEDS_API_KEY"
          ? i18n.t("settings.model.apiKey") + " — " + i18n.t("settings.saveError")
          : i18n.t("settings.saveError");
      setToast({ kind: "err", msg });
      setTimeout(() => setToast(null), 2800);
    } finally {
      setSaving(false);
    }
  }

  const isDark = themeStore.current() === "dark";
  const licColor = licenseStatusColor(status?.license?.status);

  return (
    <div data-testid="settings-page" style={{ maxWidth: 640, margin: "0 auto", padding: "40px 24px" }}>
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
          {/* ============================================================= */}
          {/*  License Information                                           */}
          {/* ============================================================= */}
          <SettingsCard
            icon="shield"
            title={i18n.t("settings.license.title")}
            desc={i18n.t("settings.license.desc")}
            testid="settings-card-license"
          >
            <InfoRow label={i18n.t("settings.license.status")}>
              <span
                data-testid="settings-license-status-pill"
                data-status={status?.license?.status ?? "unknown"}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "5px",
                  padding: "3px 10px",
                  borderRadius: "6px",
                  fontSize: "12px",
                  fontWeight: 600,
                  background: licColor.bg,
                  color: licColor.fg,
                  lineHeight: 1.4,
                }}
              >
                <span
                  style={{
                    width: "6px",
                    height: "6px",
                    borderRadius: "50%",
                    background: licColor.dot,
                  }}
                />
                {licenseStatusLabel(status?.license?.status)}
              </span>
            </InfoRow>
            {status?.license?.expires_at ? (
              <InfoRow label={i18n.t("settings.license.expires")}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>
                  {status.license.expires_at.slice(0, 10)}
                </span>
              </InfoRow>
            ) : null}
            {typeof status?.license?.days_remaining === "number" ? (
              <InfoRow label={i18n.t("settings.license.remaining")}>
                <span
                  data-testid="settings-license-remaining"
                  style={{ fontSize: 13, fontWeight: 600 }}
                >
                  {status.license.days_remaining} {i18n.t("settings.license.days")}
                </span>
              </InfoRow>
            ) : null}
            {status?.installation_id ? (
              <InfoRow label={i18n.t("settings.license.installId")}>
                <span
                  style={{
                    fontSize: 12,
                    fontFamily: "'SF Mono', Menlo, monospace",
                    color: "var(--text-secondary)",
                  }}
                >
                  {status.installation_id}
                </span>
              </InfoRow>
            ) : null}
          </SettingsCard>

          {/* ============================================================= */}
          {/*  Model Configuration                                           */}
          {/* ============================================================= */}
          <SettingsCard
            icon="lock"
            title={i18n.t("settings.model.title")}
            desc={i18n.t("settings.model.desc")}
            testid="settings-card-model"
          >
            <div style={{ display: "flex", gap: "12px", marginBottom: "18px" }}>
              <div style={{ flex: 1 }}>
                <label style={FIELD_LABEL}>{i18n.t("settings.model.protocol")}</label>
                <Select
                  testid="settings-provider-select"
                  value={provider}
                  onChange={(v) => {
                    const p = PROVIDERS.find((x) => x.value === v);
                    setProvider(v);
                    if (p) {
                      setProtoType(p.proto);
                      if (!modelId || PROVIDERS.some((x) => x.defaultModel === modelId)) {
                        setModelId(p.defaultModel);
                      }
                    }
                  }}
                  options={PROVIDERS.map((p) => ({ value: p.value, label: p.label }))}
                />
              </div>
              <div style={{ flex: 1 }}>
                <label style={FIELD_LABEL}>{i18n.t("settings.model.model")}</label>
                <input
                  data-testid="settings-model-input"
                  type="text"
                  value={modelId}
                  onChange={(e) => setModelId(e.target.value)}
                  placeholder="claude-sonnet-4-5"
                  style={FIELD_INPUT}
                />
              </div>
            </div>

            <Field label={i18n.t("settings.model.baseUrl")}>
              <input
                data-testid="settings-base-url-input"
                type="text"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder={i18n.t("settings.model.baseUrlPlaceholder")}
                style={FIELD_INPUT}
              />
            </Field>

            <Field
              label={i18n.t("settings.model.apiKey")}
              hint={cred ? i18n.t("settings.model.apiKeyLocked") : undefined}
            >
              <div style={{ position: "relative" }}>
                <input
                  data-testid="settings-api-key-input"
                  type={showKey ? "text" : "password"}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={
                    cred
                      ? "••••••••••••••••"
                      : i18n.t("settings.model.apiKeyPlaceholder")
                  }
                  autoComplete="off"
                  style={{ ...FIELD_INPUT, paddingRight: "40px" }}
                />
                <button
                  type="button"
                  data-testid="settings-api-key-toggle"
                  aria-label={showKey ? "Hide key" : "Show key"}
                  onClick={() => setShowKey((s) => !s)}
                  style={{
                    position: "absolute",
                    right: "8px",
                    top: "50%",
                    transform: "translateY(-50%)",
                    width: "28px",
                    height: "28px",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "var(--text-secondary)",
                    background: "transparent",
                    border: "none",
                    borderRadius: "4px",
                    cursor: "pointer",
                    padding: 0,
                  }}
                >
                  <Icon name={showKey ? "eye-off" : "eye"} size={16} />
                </button>
              </div>
            </Field>

            <Field
              label={i18n.t("settings.model.thinking")}
              hint={i18n.t("settings.model.thinking.hint")}
            >
              <Select
                testid="settings-thinking-select"
                value={thinking}
                onChange={(v) => setThinking(v as ThinkingValue)}
                options={THINKING_VALUES.map((v) => ({
                  value: v,
                  label: i18n.t(`settings.model.thinking.${v}`),
                }))}
              />
            </Field>
          </SettingsCard>

          {/* ============================================================= */}
          {/*  Language & Appearance                                          */}
          {/* ============================================================= */}
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

          {/* ============================================================= */}
          {/*  Engine Settings                                                */}
          {/* ============================================================= */}
          <SettingsCard
            icon="sliders"
            title={i18n.t("settings.engine.title")}
            desc={i18n.t("settings.engine.desc")}
            testid="settings-card-engine"
          >
            <Field
              label={i18n.t("settings.engine.maxParallel")}
              hint={i18n.t("settings.engine.maxParallel.hint")}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
                <input
                  type="range"
                  data-testid="settings-max-parallel-slider"
                  min={1}
                  max={10}
                  value={maxParallel}
                  onChange={(e) => setMaxParallel(Number(e.target.value))}
                  style={{ flex: 1, height: "6px", accentColor: "var(--brand)" }}
                />
                <span
                  data-testid="settings-max-parallel-value"
                  style={{
                    fontSize: "20px",
                    fontWeight: 600,
                    minWidth: "24px",
                    textAlign: "center",
                    color: "var(--text-primary)",
                    lineHeight: 1,
                  }}
                >
                  {maxParallel}
                </span>
              </div>
            </Field>
          </SettingsCard>

          <button
            type="button"
            data-testid="settings-save-btn"
            disabled={!dirty || saving || !canSaveCred}
            onClick={handleSave}
            style={{
              width: "100%",
              padding: "12px",
              marginTop: "8px",
              background: !dirty || !canSaveCred ? "var(--bg-disabled)" : "var(--brand)",
              color: "var(--btn-primary-text)",
              border: "none",
              borderRadius: "8px",
              fontSize: "14px",
              fontWeight: 600,
              cursor: !dirty || saving || !canSaveCred ? "not-allowed" : "pointer",
              opacity: !dirty || !canSaveCred ? 0.6 : 1,
              transition: "background 0.15s, opacity 0.15s",
            }}
          >
            {saving ? i18n.t("settings.saving") : i18n.t("settings.saveBtn")}
          </button>
        </>
      )}

      {/* ============================================================= */}
      {/*  Toast                                                         */}
      {/* ============================================================= */}
      {toast ? (
        <div
          data-testid="settings-toast"
          data-kind={toast.kind}
          role="status"
          style={{
            position: "fixed",
            bottom: "32px",
            left: "50%",
            transform: "translateX(-50%)",
            background: toast.kind === "ok" ? "rgba(0,0,0,0.92)" : "var(--brand)",
            color: "#fff",
            padding: "10px 24px",
            borderRadius: "8px",
            fontSize: "13px",
            fontWeight: 500,
            boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
            zIndex: 400,
            transition: "opacity 0.2s",
            pointerEvents: "none",
          }}
        >
          {toast.msg}
        </div>
      ) : null}
    </div>
  );
}

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "10px 0",
        borderTop: "1px solid var(--divider)",
      }}
    >
      <span style={{ fontSize: "13px", color: "var(--text-secondary)" }}>{label}</span>
      {children}
    </div>
  );
}

function Select({
  value,
  onChange,
  options,
  testid,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  testid?: string;
}) {
  return (
    <select
      data-testid={testid}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{
        ...FIELD_INPUT,
        appearance: "none",
        backgroundImage:
          "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23737373' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E\")",
        backgroundRepeat: "no-repeat",
        backgroundPosition: "right 12px center",
        paddingRight: "32px",
        cursor: "pointer",
      }}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
