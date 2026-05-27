import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../../shared/api/client.js";
import { i18n } from "../../../shared/i18n/index.js";
import { AuthSplitLayout } from "../../../shared/components/AuthSplitLayout.js";

export function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [, forceI18n] = useState(0);
  useEffect(() => i18n.onChange(() => forceI18n((n) => n + 1)), []);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await api.auth.login(email, password);
      qc.clear();
      if (res.user?.mustChangePassword) {
        navigate("/change-password");
      } else {
        navigate("/dashboard");
      }
    } catch (err) {
      const code = (err as Error & { code?: string }).code;
      if (code === "ERR_AUTH_LOCKED") setError(i18n.t("login.errorLocked"));
      else setError(i18n.t("login.errorInvalid"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthSplitLayout testid="login-page">
      <h1 style={{ fontSize: "24px", fontWeight: 700, margin: "0 0 6px", letterSpacing: "-0.01em" }}>
        {i18n.t("login.title")}
      </h1>
      <p style={{ fontSize: "14px", color: "var(--text-secondary)", margin: "0 0 28px", lineHeight: 1.6 }}>
        {i18n.t("login.subtitle")}
      </p>

      <form onSubmit={handleLogin}>
        {[
          {
            label: i18n.t("login.email"),
            value: email,
            onChange: setEmail,
            type: "email",
            testid: "login-email",
            placeholder: "you@company.com",
            autoComplete: "username",
          },
          {
            label: i18n.t("login.password"),
            value: password,
            onChange: setPassword,
            type: "password",
            testid: "login-password",
            placeholder: "••••••••",
            autoComplete: "current-password",
          },
        ].map((f, idx) => (
          <div key={f.label} style={{ marginTop: idx === 0 ? 0 : "18px" }}>
            <label
              style={{
                display: "block",
                fontSize: "12px",
                fontWeight: 500,
                color: "var(--text-primary)",
                marginBottom: "4px",
              }}
            >
              {f.label}
            </label>
            <input
              data-testid={f.testid}
              type={f.type}
              value={f.value}
              onChange={(e) => f.onChange(e.target.value)}
              required
              placeholder={f.placeholder}
              autoComplete={f.autoComplete}
              onFocus={(e) => (e.currentTarget.style.borderBottomColor = "var(--brand)")}
              onBlur={(e) => (e.currentTarget.style.borderBottomColor = "var(--border)")}
              style={{
                width: "100%",
                border: "none",
                borderBottom: "1.5px solid var(--border)",
                background: "transparent",
                padding: "10px 0",
                fontSize: "14px",
                color: "var(--text-primary)",
                outline: "none",
                transition: "border-color 0.15s",
              }}
            />
          </div>
        ))}

        {error && (
          <p
            style={{
              color: "var(--brand)",
              fontSize: "13px",
              marginTop: "14px",
              marginBottom: 0,
            }}
          >
            {error}
          </p>
        )}

        <button
          data-testid="login-submit"
          type="submit"
          disabled={loading}
          style={{
            width: "100%",
            padding: "13px",
            marginTop: "28px",
            background: loading ? "var(--bg-disabled)" : "var(--brand)",
            color: loading ? "var(--text-secondary)" : "var(--btn-primary-text)",
            border: "none",
            borderRadius: "6px",
            fontSize: "14px",
            fontWeight: 600,
            cursor: loading ? "not-allowed" : "pointer",
            transition: "background 0.15s",
          }}
          onMouseEnter={(e) => {
            if (!loading) e.currentTarget.style.background = "#b91c1c";
          }}
          onMouseLeave={(e) => {
            if (!loading) e.currentTarget.style.background = "var(--brand)";
          }}
        >
          {loading ? i18n.t("login.signing") : i18n.t("login.submit")}
        </button>
      </form>
    </AuthSplitLayout>
  );
}
