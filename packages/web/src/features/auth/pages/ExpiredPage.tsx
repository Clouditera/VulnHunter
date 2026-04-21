import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../../shared/api/client.js";
import { i18n } from "../../../shared/i18n/index.js";

export function ExpiredPage() {
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [, forceI18n] = useState(0);
  useEffect(() => i18n.onChange(() => forceI18n((n) => n + 1)), []);

  async function handleRenew(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await api.system.activate(key.trim());
      setSuccess(true);
      qc.invalidateQueries({ queryKey: ["system-status"] });
      setTimeout(() => navigate("/login"), 1500);
    } catch {
      setError(i18n.t("expired.error"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      data-testid="expired-page"
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--bg-page)",
      }}
    >
      <div
        style={{
          background: "var(--bg-card)",
          borderRadius: "10px",
          padding: "48px",
          width: "420px",
          boxShadow: "0 4px 24px rgba(0,0,0,0.08)",
        }}
      >
        <div style={{ textAlign: "center", marginBottom: "32px" }}>
          <div
            style={{
              width: "56px",
              height: "56px",
              borderRadius: "50%",
              background: "var(--bg-warning)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              margin: "0 auto 16px",
              fontSize: "24px",
            }}
          >
            ⏰
          </div>
          <h1 style={{ fontSize: "22px", fontWeight: 700, margin: "0 0 8px" }}>
            {i18n.t("expired.title")}
          </h1>
          <p style={{ fontSize: "14px", color: "var(--text-secondary)", margin: 0, lineHeight: 1.6 }}>
            {i18n.t("expired.desc")}
          </p>
        </div>

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
            {i18n.t("expired.success")}
          </div>
        ) : (
          <form onSubmit={handleRenew}>
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
              {i18n.t("expired.renewalKey")}
            </label>
            <textarea
              data-testid="renewal-key-input"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={i18n.t("expired.placeholder")}
              rows={5}
              style={{
                width: "100%",
                border: "1px solid var(--border)",
                borderRadius: "6px",
                padding: "10px 12px",
                fontSize: "12px",
                fontFamily: "monospace",
                background: "var(--bg-page)",
                color: "var(--text-primary)",
                resize: "vertical",
                outline: "none",
              }}
              required
            />
            {error && (
              <p style={{ color: "var(--brand)", fontSize: "13px", margin: "8px 0 0" }}>
                {error}
              </p>
            )}
            <button
              data-testid="renew-submit"
              type="submit"
              disabled={loading || !key.trim()}
              style={{
                marginTop: "16px",
                width: "100%",
                padding: "12px",
                background: loading || !key.trim() ? "var(--bg-disabled)" : "var(--brand)",
                color: loading || !key.trim() ? "var(--text-secondary)" : "var(--btn-primary-text)",
                border: "none",
                borderRadius: "6px",
                fontSize: "14px",
                fontWeight: 600,
                cursor: loading || !key.trim() ? "not-allowed" : "pointer",
              }}
            >
              {loading ? i18n.t("expired.renewing") : i18n.t("expired.submit")}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
