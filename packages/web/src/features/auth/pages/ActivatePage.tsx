import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../../shared/api/client.js";
import { i18n } from "../../../shared/i18n/index.js";
import { AuthSplitLayout } from "../../../shared/components/AuthSplitLayout.js";
import { Icon } from "../../../shared/components/Icon.js";
import { useSystemStatus } from "../hooks/useSystemStatus.js";

function licenseErrorMessage(err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  const key = `activate.error.${detail}`;
  const translated = i18n.t(key);
  return translated === key ? i18n.t("activate.error.default") : translated;
}

export function ActivatePage() {
  const [cert, setCert] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: status } = useSystemStatus();
  const machineCode = status?.license.machine_code ?? status?.installation_id ?? "";
  const [, forceI18n] = useState(0);
  useEffect(() => i18n.onChange(() => forceI18n((n) => n + 1)), []);

  async function copyMachineCode() {
    if (!machineCode) return;
    setError("");
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard_unavailable");
      await navigator.clipboard.writeText(machineCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError(i18n.t("activate.copyFailed"));
    }
  }

  async function handleActivate(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await api.system.activate(cert.trim());
      setSuccess(true);
      await qc.invalidateQueries({ queryKey: ["system-status"] });
      qc.removeQueries({ queryKey: ["system-status"] });
      setTimeout(() => navigate("/"), 1500);
    } catch (err) {
      setError(licenseErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthSplitLayout testid="activate-page">
      <div style={{ width: "44px", height: "44px", borderRadius: "50%", background: "var(--bg-error)", color: "var(--brand)", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: "20px" }}>
        <Icon name="shield" size={22} />
      </div>
      <h1 style={{ fontSize: "24px", fontWeight: 700, margin: "0 0 6px", letterSpacing: "-0.01em" }}>
        {i18n.t("activate.title")}
      </h1>
      <p style={{ fontSize: "14px", color: "var(--text-secondary)", margin: "0 0 18px", lineHeight: 1.6 }}>
        {i18n.t("activate.desc")}
      </p>

      <div data-testid="machine-code-panel" style={{ padding: "12px", border: "1px solid var(--border)", borderRadius: "8px", background: "var(--bg-page)", marginBottom: "14px" }}>
        <div style={{ fontSize: "11px", fontWeight: 600, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "6px" }}>
          {i18n.t("activate.machineCode")}
        </div>
        <div data-testid="machine-code" style={{ fontFamily: "SF Mono, JetBrains Mono, monospace", fontSize: "12px", color: "var(--text-primary)", wordBreak: "break-all", marginBottom: "10px" }}>
          {machineCode || "—"}
        </div>
        <button data-testid="copy-machine-code" type="button" onClick={copyMachineCode} disabled={!machineCode} style={{ height: 30, border: "1px solid var(--border)", borderRadius: 6, background: "transparent", color: "var(--text-secondary)", padding: "0 10px", cursor: machineCode ? "pointer" : "not-allowed" }}>
          {copied ? i18n.t("activate.copied") : i18n.t("activate.copyMachineCode")}
        </button>
      </div>

      <p style={{ whiteSpace: "pre-line", fontSize: "12px", color: "var(--text-secondary)", lineHeight: 1.6, margin: "0 0 18px" }}>
        {i18n.t("activate.steps")}
      </p>

      {success ? (
        <div style={{ padding: "12px 16px", background: "var(--bg-success)", border: "1px solid var(--bg-success-border)", borderRadius: "6px", color: "var(--bg-success-text)", fontSize: "14px" }}>
          {i18n.t("activate.success")}
        </div>
      ) : (
        <form onSubmit={handleActivate}>
          <label style={{ display: "block", fontSize: "11px", fontWeight: 600, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "6px" }}>
            {i18n.t("activate.licenseKey")}
          </label>
          <textarea data-testid="license-key-input" value={cert} onChange={(e) => setCert(e.target.value)} placeholder={i18n.t("activate.placeholder")} rows={5} onFocus={(e) => (e.currentTarget.style.borderColor = "var(--brand)")} onBlur={(e) => (e.currentTarget.style.borderColor = "var(--border)")} style={{ width: "100%", border: "1px solid var(--border)", borderRadius: "6px", padding: "10px 12px", fontSize: "12px", fontFamily: "SF Mono, JetBrains Mono, monospace", background: "var(--bg-page)", color: "var(--text-primary)", resize: "vertical", outline: "none", transition: "border-color 0.15s" }} required />
          {error && <p data-testid="license-error" style={{ color: "var(--brand)", fontSize: "13px", margin: "10px 0 0" }}>{error}</p>}
          <button data-testid="activate-submit" type="submit" disabled={loading || !cert.trim()} style={{ marginTop: "20px", width: "100%", padding: "13px", background: loading || !cert.trim() ? "var(--bg-disabled)" : "var(--brand)", color: loading || !cert.trim() ? "var(--text-secondary)" : "var(--btn-primary-text)", border: "none", borderRadius: "6px", fontSize: "14px", fontWeight: 600, cursor: loading || !cert.trim() ? "not-allowed" : "pointer", transition: "background 0.15s" }}>
            {loading ? i18n.t("activate.activating") : i18n.t("activate.submit")}
          </button>
        </form>
      )}
    </AuthSplitLayout>
  );
}
