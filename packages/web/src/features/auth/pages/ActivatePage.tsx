import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../../shared/api/client.js";
import { i18n } from "../../../shared/i18n/index.js";
import { AuthSplitLayout } from "../../../shared/components/AuthSplitLayout.js";
import { Icon } from "../../../shared/components/Icon.js";

export function ActivatePage() {
  const [cert, setCert] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [, forceI18n] = useState(0);
  useEffect(() => i18n.onChange(() => forceI18n((n) => n + 1)), []);

  async function handleActivate(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await api.system.activate(cert.trim());
      setSuccess(true);
      qc.invalidateQueries({ queryKey: ["system-status"] });
      setTimeout(() => navigate("/login"), 1500);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthSplitLayout testid="activate-page">
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
        {i18n.t("activate.title")}
      </h1>
      <p
        style={{
          fontSize: "14px",
          color: "var(--text-secondary)",
          margin: "0 0 28px",
          lineHeight: 1.6,
        }}
      >
        {i18n.t("activate.desc")}
      </p>

      {success ? (
        <div
          style={{
            padding: "12px 16px",
            background: "var(--bg-success)",
            border: "1px solid var(--bg-success-border)",
            borderRadius: "6px",
            color: "var(--bg-success-text)",
            fontSize: "14px",
          }}
        >
          {i18n.t("activate.success")}
        </div>
      ) : (
        <form onSubmit={handleActivate}>
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
            {i18n.t("activate.licenseKey")}
          </label>
          <textarea
            data-testid="license-key-input"
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
          {error && (
            <p style={{ color: "var(--brand)", fontSize: "13px", margin: "10px 0 0" }}>{error}</p>
          )}
          <button
            data-testid="activate-submit"
            type="submit"
            disabled={loading || !cert.trim()}
            style={{
              marginTop: "20px",
              width: "100%",
              padding: "13px",
              background: loading || !cert.trim() ? "var(--bg-disabled)" : "var(--brand)",
              color:
                loading || !cert.trim()
                  ? "var(--text-secondary)"
                  : "var(--btn-primary-text)",
              border: "none",
              borderRadius: "6px",
              fontSize: "14px",
              fontWeight: 600,
              cursor: loading || !cert.trim() ? "not-allowed" : "pointer",
              transition: "background 0.15s",
            }}
            onMouseEnter={(e) => {
              if (!(loading || !cert.trim())) e.currentTarget.style.background = "#b91c1c";
            }}
            onMouseLeave={(e) => {
              if (!(loading || !cert.trim())) e.currentTarget.style.background = "var(--brand)";
            }}
          >
            {loading ? i18n.t("activate.activating") : i18n.t("activate.submit")}
          </button>
          <p
            style={{
              fontSize: "12px",
              color: "var(--text-tertiary, var(--text-secondary))",
              marginTop: "14px",
              textAlign: "center",
            }}
          >
            {i18n.t("activate.footer") !== "activate.footer"
              ? i18n.t("activate.footer")
              : ""}
          </p>
        </form>
      )}
    </AuthSplitLayout>
  );
}
