import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../../shared/api/client.js";
import { ApiError } from "../../../shared/api/error.js";
import { i18n } from "../../../shared/i18n/index.js";
import { AuthSplitLayout } from "../../../shared/components/AuthSplitLayout.js";
import { Icon } from "../../../shared/components/Icon.js";
import { useSystemStatus } from "../../auth/hooks/useSystemStatus.js";
import { copyText } from "../../../shared/lib/copy-text.js";
import { isStrongPassword } from "../../../shared/lib/password.js";

function licenseErrorMessage(err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  const key = `activate.error.${detail}`;
  const translated = i18n.t(key);
  return translated === key ? i18n.t("activate.error.default") : translated;
}

function setupErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === "ERR_LICENSE_NOT_ACTIVATED") return i18n.t("setup.account.error.licenseFirst");
    if (err.code === "ERR_ADMIN_SINGLETON") return i18n.t("setup.account.error.sealed");
    if (err.code === "rate_limited") return i18n.t("setup.account.error.rateLimited");
  }
  return i18n.t("setup.account.error.default");
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function StepDot(props: { n: number; label: string; state: "done" | "active" | "pending" }) {
  const { n, label, state } = props;
  return (
    <div data-testid={`setup-step-${n}`} style={{ display: "flex", alignItems: "center", gap: "8px" }}>
      <span
        style={{
          width: "22px",
          height: "22px",
          borderRadius: "50%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "12px",
          fontWeight: 700,
          background: state === "active" ? "var(--brand)" : state === "done" ? "var(--bg-success)" : "transparent",
          color: state === "pending" ? "var(--text-secondary)" : state === "done" ? "var(--bg-success-text)" : "var(--btn-primary-text)",
          border: state === "pending" ? "1px solid var(--border)" : "none",
        }}
      >
        {state === "done" ? "✓" : n}
      </span>
      <span
        style={{
          fontSize: "13px",
          fontWeight: state === "active" ? 600 : 500,
          color: state === "pending" ? "var(--text-secondary)" : "var(--text-primary)",
        }}
      >
        {label}
      </span>
    </div>
  );
}

function FieldLabel(props: { children: string }) {
  return (
    <label
      style={{
        display: "block",
        fontSize: "11px",
        fontWeight: 600,
        color: "var(--text-secondary)",
        textTransform: "uppercase",
        letterSpacing: "0.05em",
        marginBottom: "6px",
      }}
    >
      {props.children}
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  height: "40px",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  padding: "0 12px",
  fontSize: "14px",
  background: "var(--bg-page)",
  color: "var(--text-primary)",
  outline: "none",
};

/**
 * First-run setup wizard (fish 2026-08-06, single-path onboarding). Lives on
 * the admin console; exists only while has_admin=false (SetupGuard seals it
 * afterwards, backend triple-seals the endpoint).
 * Step 1 license activation is skipped on community edition or when the
 * license is already active (e.g. activated earlier, admin creation aborted).
 */
export function SetupWizardPage() {
  const { data: status } = useSystemStatus();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [, forceI18n] = useState(0);
  useEffect(() => i18n.onChange(() => forceI18n((n) => n + 1)), []);

  const licenseNeeded =
    !!status && status.edition !== "community" && status.license.status !== "active";
  const [licenseDone, setLicenseDone] = useState(false);
  const step: "license" | "account" = licenseNeeded && !licenseDone ? "license" : "account";

  // ---- license step ----
  const [cert, setCert] = useState("");
  const [licenseError, setLicenseError] = useState("");
  const [licenseLoading, setLicenseLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const machineCode = status?.license.machine_code ?? status?.installation_id ?? "";

  async function copyMachineCode() {
    if (!machineCode) return;
    setLicenseError("");
    try {
      const ok = await copyText(machineCode);
      if (!ok) throw new Error("copy_failed");
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setLicenseError(i18n.t("activate.copyFailed"));
    }
  }

  async function handleActivate(e: React.FormEvent) {
    e.preventDefault();
    setLicenseError("");
    setLicenseLoading(true);
    try {
      await api.system.activate(cert.trim());
      await qc.invalidateQueries({ queryKey: ["system-status"] });
      setLicenseDone(true);
    } catch (err) {
      setLicenseError(licenseErrorMessage(err));
    } finally {
      setLicenseLoading(false);
    }
  }

  // ---- account step ----
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [accountError, setAccountError] = useState("");
  const [accountLoading, setAccountLoading] = useState(false);
  const [created, setCreated] = useState(false);

  const emailOk = EMAIL_RE.test(email);
  const pwdStrong = isStrongPassword(password);
  const pwdMatch = confirm === password;
  const canSubmit = emailOk && pwdStrong && pwdMatch && !accountLoading;

  async function handleCreateAdmin(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setAccountError("");
    setAccountLoading(true);
    try {
      await api.system.createInitialAdmin(email.trim(), password);
      setCreated(true);
      await qc.invalidateQueries({ queryKey: ["system-status"] });
      qc.removeQueries({ queryKey: ["system-status"] });
      setTimeout(() => navigate("/login"), 1500);
    } catch (err) {
      setAccountError(setupErrorMessage(err));
    } finally {
      setAccountLoading(false);
    }
  }

  return (
    <AuthSplitLayout testid="setup-page">
      <div
        style={{
          width: "44px",
          height: "44px",
          borderRadius: "50%",
          background: "var(--bg-error)",
          color: "var(--brand)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          marginBottom: "20px",
        }}
      >
        <Icon name="shield" size={22} />
      </div>
      <h1 style={{ fontSize: "24px", fontWeight: 700, margin: "0 0 6px", letterSpacing: "-0.01em" }}>
        {i18n.t("setup.title")}
      </h1>
      <p style={{ fontSize: "14px", color: "var(--text-secondary)", margin: "0 0 18px", lineHeight: 1.6 }}>
        {i18n.t("setup.desc")}
      </p>

      {licenseNeeded && (
        <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "22px" }}>
          <StepDot n={1} label={i18n.t("setup.step.license")} state={step === "license" ? "active" : "done"} />
          <span style={{ flex: "0 0 24px", height: "1px", background: "var(--border)" }} />
          <StepDot n={2} label={i18n.t("setup.step.account")} state={step === "account" ? "active" : "pending"} />
        </div>
      )}

      {step === "license" ? (
        <>
          <div
            data-testid="setup-machine-code-panel"
            style={{
              padding: "12px",
              border: "1px solid var(--border)",
              borderRadius: "8px",
              background: "var(--bg-page)",
              marginBottom: "14px",
            }}
          >
            <div
              style={{
                fontSize: "11px",
                fontWeight: 600,
                color: "var(--text-secondary)",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                marginBottom: "6px",
              }}
            >
              {i18n.t("activate.machineCode")}
            </div>
            <div
              data-testid="setup-machine-code"
              style={{
                fontFamily: "SF Mono, JetBrains Mono, monospace",
                fontSize: "12px",
                color: "var(--text-primary)",
                wordBreak: "break-all",
                marginBottom: "10px",
              }}
            >
              {machineCode || "—"}
            </div>
            <button
              data-testid="setup-copy-machine-code"
              type="button"
              onClick={copyMachineCode}
              disabled={!machineCode}
              style={{
                height: 30,
                border: "1px solid var(--border)",
                borderRadius: 6,
                background: "transparent",
                color: "var(--text-secondary)",
                padding: "0 10px",
                cursor: machineCode ? "pointer" : "not-allowed",
              }}
            >
              {copied ? i18n.t("activate.copied") : i18n.t("activate.copyMachineCode")}
            </button>
          </div>

          <p style={{ whiteSpace: "pre-line", fontSize: "12px", color: "var(--text-secondary)", lineHeight: 1.6, margin: "0 0 18px" }}>
            {i18n.t("activate.steps")}
          </p>

          <form onSubmit={handleActivate}>
            <FieldLabel>{i18n.t("activate.licenseKey")}</FieldLabel>
            <textarea
              data-testid="setup-license-key-input"
              value={cert}
              onChange={(e) => setCert(e.target.value)}
              placeholder={i18n.t("activate.placeholder")}
              rows={5}
              onFocus={(e) => (e.currentTarget.style.borderColor = "var(--brand)")}
              onBlur={(e) => (e.currentTarget.style.borderColor = "var(--border)")}
              style={{
                width: "100%",
                border: "1px solid var(--border)",
                borderRadius: "6px",
                padding: "10px 12px",
                fontSize: "12px",
                fontFamily: "SF Mono, JetBrains Mono, monospace",
                background: "var(--bg-page)",
                color: "var(--text-primary)",
                resize: "vertical",
                outline: "none",
                transition: "border-color 0.15s",
              }}
              required
            />
            {licenseError && (
              <p data-testid="setup-license-error" style={{ color: "var(--brand)", fontSize: "13px", margin: "10px 0 0" }}>
                {licenseError}
              </p>
            )}
            <button
              data-testid="setup-license-submit"
              type="submit"
              disabled={licenseLoading || !cert.trim()}
              style={{
                marginTop: "20px",
                width: "100%",
                padding: "13px",
                background: licenseLoading || !cert.trim() ? "var(--bg-disabled)" : "var(--brand)",
                color: licenseLoading || !cert.trim() ? "var(--text-secondary)" : "var(--btn-primary-text)",
                border: "none",
                borderRadius: "6px",
                fontSize: "14px",
                fontWeight: 600,
                cursor: licenseLoading || !cert.trim() ? "not-allowed" : "pointer",
                transition: "background 0.15s",
              }}
            >
              {licenseLoading ? i18n.t("activate.activating") : i18n.t("activate.submit")}
            </button>
          </form>
        </>
      ) : created ? (
        <div
          data-testid="setup-account-success"
          style={{
            padding: "12px 16px",
            background: "var(--bg-success)",
            border: "1px solid var(--bg-success-border)",
            borderRadius: "6px",
            color: "var(--bg-success-text)",
            fontSize: "14px",
          }}
        >
          {i18n.t("setup.account.success")}
        </div>
      ) : (
        <form onSubmit={handleCreateAdmin}>
          <div style={{ marginBottom: "16px" }}>
            <FieldLabel>{i18n.t("setup.account.email")}</FieldLabel>
            <input
              data-testid="setup-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              style={inputStyle}
            />
          </div>
          <div style={{ marginBottom: "16px" }}>
            <FieldLabel>{i18n.t("setup.account.password")}</FieldLabel>
            <input
              data-testid="setup-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              style={inputStyle}
            />
            {password && !pwdStrong && (
              <p data-testid="setup-password-hint" style={{ color: "var(--brand)", fontSize: "12px", margin: "6px 0 0" }}>
                {i18n.t("auth.err.weakPassword")}
              </p>
            )}
          </div>
          <div style={{ marginBottom: "16px" }}>
            <FieldLabel>{i18n.t("setup.account.confirm")}</FieldLabel>
            <input
              data-testid="setup-confirm"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              style={inputStyle}
            />
            {confirm && !pwdMatch && (
              <p data-testid="setup-confirm-hint" style={{ color: "var(--brand)", fontSize: "12px", margin: "6px 0 0" }}>
                {i18n.t("profile.err.mismatch")}
              </p>
            )}
          </div>

          {accountError && (
            <p data-testid="setup-account-error" style={{ color: "var(--brand)", fontSize: "13px", margin: "0 0 12px" }}>
              {accountError}
            </p>
          )}

          <button
            data-testid="setup-account-submit"
            type="submit"
            disabled={!canSubmit}
            style={{
              width: "100%",
              padding: "12px",
              background: canSubmit ? "var(--brand)" : "var(--bg-disabled)",
              color: canSubmit ? "var(--btn-primary-text)" : "var(--text-secondary)",
              border: "none",
              borderRadius: "6px",
              fontSize: "14px",
              fontWeight: 600,
              cursor: canSubmit ? "pointer" : "not-allowed",
            }}
          >
            {accountLoading ? i18n.t("setup.account.creating") : i18n.t("setup.account.submit")}
          </button>
        </form>
      )}
    </AuthSplitLayout>
  );
}
