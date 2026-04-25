/**
 * POC/EXP Settings section — DeVeye Server configuration + test connection.
 * Matches SettingsCard visual pattern (borderRadius: 12px, padding: 24px).
 */

import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import type { CSSProperties } from "react";
import { api } from "../../../shared/api/client.js";
import { i18n } from "../../../shared/i18n/index.js";
import { Icon } from "../../../shared/components/Icon.js";

export function PocSettingsSection() {
  const [, force] = useState(0);
  useEffect(() => i18n.onChange(() => force((n) => n + 1)), []);

  const { data } = useQuery({
    queryKey: ["poc-settings"],
    queryFn: () => api.settings.getPocSettings(),
  });
  const settings = data?.settings;

  const [serverUrl, setServerUrl] = useState("");
  const [token, setToken] = useState("");
  const [timeout, setTimeout_] = useState("1800");
  const [concurrency, setConcurrency] = useState("1");
  const [showToken, setShowToken] = useState(false);
  const [helpExpanded, setHelpExpanded] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; server_version?: string; error?: string } | null>(null);
  const [saveLabel, setSaveLabel] = useState<"default" | "saving" | "saved">("default");

  useEffect(() => {
    if (settings) {
      setServerUrl(settings.deveye_server_url ?? "");
      setToken(settings.deveye_token ?? "");
      setTimeout_(String(settings.poc_timeout_s ?? 1800));
      setConcurrency(String(settings.default_concurrency ?? 1));
    }
  }, [settings]);

  const saveMut = useMutation({
    mutationFn: () =>
      api.settings.updatePocSettings({
        deveye_server_url: serverUrl || undefined,
        deveye_token: token || undefined,
        poc_timeout_s: Number(timeout) || 1800,
        default_concurrency: Number(concurrency) || 1,
      }),
    onSuccess: () => {
      setSaveLabel("saved");
      setTimeout(() => setSaveLabel("default"), 2000);
    },
  });

  const testMut = useMutation({
    mutationFn: () =>
      api.settings.testPocConnection({
        server_url: serverUrl || undefined,
        token: token || undefined,
      }),
    onSuccess: (result) => setTestResult(result),
    onError: () => setTestResult({ ok: false, error: "Request failed" }),
  });

  return (
    <section style={CARD} data-testid="settings-card-poc">
      {/* Header — matches SettingsCard pattern */}
      <div style={{ marginBottom: "20px" }}>
        <h3 style={HEADER_TITLE}>
          <Icon name="code" size={18} style={{ color: "var(--text-secondary)" }} />
          <span>{i18n.t("settings.poc.title")}</span>
        </h3>
        <p style={HEADER_DESC}>{i18n.t("settings.poc.desc")}</p>
      </div>

      {/* Help banner */}
      <div style={HELP_BANNER}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <Icon name="info" size={14} style={{ color: "#2563eb", flexShrink: 0 }} />
          <span style={{ fontSize: "13px", color: "#1e40af" }}>
            {i18n.t("settings.poc.help.title")}。{i18n.t("settings.poc.help.desc")}
          </span>
        </div>
        <button
          onClick={() => setHelpExpanded(!helpExpanded)}
          style={{ ...GHOST_BTN, color: "#2563eb", marginTop: "6px", fontSize: "12px" }}
        >
          {helpExpanded ? "▾" : "▸"} {i18n.t("settings.poc.help.install")}
        </button>
        {helpExpanded && (
          <div style={{ marginTop: "10px", fontSize: "12px", lineHeight: 1.7, color: "#374151" }}>
            <p style={{ margin: "0 0 8px" }}>1. {i18n.t("settings.poc.help.step1")}</p>
            <p style={{ margin: "0 0 8px" }}>2. {i18n.t("settings.poc.help.step2")}</p>
            <pre style={CODE_BLOCK}>
              deveye server start --host 0.0.0.0 --port 9888 --token &lt;your-token&gt;
            </pre>
            <p style={{ margin: "8px 0" }}>3. {i18n.t("settings.poc.help.step3")}</p>
            <p style={{ margin: "0" }}>4. {i18n.t("settings.poc.help.step4")}</p>
          </div>
        )}
      </div>

      {/* Form fields */}
      <div style={{ display: "flex", flexDirection: "column", gap: "16px", marginTop: "16px" }}>
        <div>
          <label style={LABEL}>{i18n.t("settings.poc.serverUrl")}</label>
          <input
            value={serverUrl}
            onChange={(e) => { setServerUrl(e.target.value); setTestResult(null); }}
            placeholder="ws://192.168.x.x:9888"
            style={INPUT}
          />
          <div style={HINT}>{i18n.t("settings.poc.serverUrlHint")}</div>
        </div>

        <div>
          <label style={LABEL}>{i18n.t("settings.poc.token")}</label>
          <div style={{ position: "relative" }}>
            <input
              type={showToken ? "text" : "password"}
              value={token}
              onChange={(e) => { setToken(e.target.value); setTestResult(null); }}
              placeholder={i18n.t("settings.poc.tokenHint")}
              style={{ ...INPUT, paddingRight: "40px" }}
            />
            <button
              type="button"
              onClick={() => setShowToken(!showToken)}
              style={{ position: "absolute", right: "8px", top: "50%", transform: "translateY(-50%)", ...GHOST_BTN, padding: "4px" }}
            >
              <Icon name={showToken ? "eye-off" : "eye"} size={14} />
            </button>
          </div>
        </div>

        <div style={{ display: "flex", gap: "16px" }}>
          <div style={{ flex: 1 }}>
            <label style={LABEL}>{i18n.t("settings.poc.timeout")}</label>
            <input type="number" value={timeout} onChange={(e) => setTimeout_(e.target.value)} min={60} max={7200} style={INPUT} />
          </div>
          <div style={{ flex: 1 }}>
            <label style={LABEL}>{i18n.t("settings.poc.concurrency")}</label>
            <input type="number" value={concurrency} onChange={(e) => setConcurrency(e.target.value)} min={1} max={5} style={INPUT} />
          </div>
        </div>

        {/* Test result */}
        {testResult && (
          <div style={{
            padding: "10px 14px",
            borderRadius: "6px",
            fontSize: "12px",
            lineHeight: 1.5,
            background: testResult.ok ? "#dcfce7" : "#fee2e2",
            color: testResult.ok ? "#166534" : "#991b1b",
            border: `1px solid ${testResult.ok ? "#bbf7d0" : "#fecaca"}`,
          }}>
            {testResult.ok ? (
              <>✓ {i18n.t("settings.poc.testSuccess")}{testResult.server_version ? ` · DeVeye Server ${testResult.server_version}` : ""}</>
            ) : (
              <>
                ✕ {i18n.t("settings.poc.testFailed")}
                {testResult.error && <div style={{ marginTop: "4px", opacity: 0.8 }}>{testResult.error}</div>}
              </>
            )}
          </div>
        )}

        {/* Actions */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
          <button
            onClick={() => testMut.mutate()}
            disabled={!serverUrl || testMut.isPending}
            style={{
              ...OUTLINE_BTN,
              opacity: !serverUrl || testMut.isPending ? 0.5 : 1,
            }}
          >
            {testMut.isPending ? i18n.t("settings.poc.testing") : i18n.t("settings.poc.testConnection")}
          </button>
          <button
            onClick={() => { setSaveLabel("saving"); saveMut.mutate(); }}
            disabled={saveMut.isPending}
            style={{
              ...PRIMARY_BTN,
              opacity: saveMut.isPending ? 0.6 : 1,
            }}
          >
            {saveLabel === "saving" ? "..." : saveLabel === "saved" ? `✓ ${i18n.t("settings.poc.saveSuccess")}` : i18n.t("settings.poc.save")}
          </button>
        </div>
      </div>
    </section>
  );
}

/* ── Styles matching SettingsCard pattern ── */

const CARD: CSSProperties = {
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: "12px",
  padding: "24px",
  marginBottom: "16px",
};

const HEADER_TITLE: CSSProperties = {
  fontSize: "15px",
  fontWeight: 600,
  margin: "0 0 4px",
  display: "flex",
  alignItems: "center",
  gap: "8px",
  color: "var(--text-primary)",
};

const HEADER_DESC: CSSProperties = {
  fontSize: "13px",
  color: "var(--text-secondary)",
  opacity: 0.85,
  margin: 0,
};

const LABEL: CSSProperties = {
  display: "block",
  fontSize: "12px",
  fontWeight: 600,
  color: "var(--text-primary)",
  marginBottom: "6px",
};

const INPUT: CSSProperties = {
  width: "100%",
  padding: "9px 12px",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  fontSize: "13px",
  background: "var(--bg-card)",
  color: "var(--text-primary)",
  outline: "none",
  fontFamily: "inherit",
  boxSizing: "border-box",
};

const HINT: CSSProperties = {
  fontSize: "11px",
  color: "var(--text-secondary)",
  marginTop: "4px",
};

const GHOST_BTN: CSSProperties = {
  background: "transparent",
  border: "none",
  cursor: "pointer",
  color: "var(--text-secondary)",
  fontFamily: "inherit",
  padding: 0,
};

const OUTLINE_BTN: CSSProperties = {
  padding: "8px 16px",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  background: "transparent",
  color: "var(--text-primary)",
  fontSize: "13px",
  fontWeight: 500,
  cursor: "pointer",
  fontFamily: "inherit",
};

const PRIMARY_BTN: CSSProperties = {
  padding: "8px 16px",
  border: "none",
  borderRadius: "6px",
  background: "var(--brand)",
  color: "var(--btn-primary-text, #fff)",
  fontSize: "13px",
  fontWeight: 600,
  cursor: "pointer",
};

const HELP_BANNER: CSSProperties = {
  background: "#eff6ff",
  border: "1px solid #bfdbfe",
  borderRadius: "8px",
  padding: "12px 14px",
};

const CODE_BLOCK: CSSProperties = {
  margin: "4px 0",
  padding: "8px 12px",
  background: "var(--bg-page)",
  borderRadius: "4px",
  fontFamily: "'SF Mono', Menlo, Consolas, monospace",
  fontSize: "12px",
  overflow: "auto",
};
