import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../../shared/api/client.js";

export function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await api.auth.login(email, password);
      qc.invalidateQueries({ queryKey: ["system-status"] });
      navigate("/dashboard");
    } catch (err) {
      const code = (err as Error & { code?: string }).code;
      if (code === "ERR_AUTH_LOCKED") {
        setError("Too many failed attempts. Try again in 15 minutes.");
      } else {
        setError("Invalid email or password.");
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      data-testid="login-page"
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
          width: "400px",
          boxShadow: "0 4px 24px rgba(0,0,0,0.08)",
        }}
      >
        <div style={{ textAlign: "center", marginBottom: "32px" }}>
          <div
            style={{
              width: "40px",
              height: "40px",
              borderRadius: "10px",
              background: "var(--brand)",
              color: "var(--btn-primary-text)",
              fontWeight: 800,
              fontSize: "18px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              margin: "0 auto 16px",
            }}
          >
            V
          </div>
          <h1 style={{ fontSize: "22px", fontWeight: 700, margin: "0 0 4px" }}>VulnHunt</h1>
          <p style={{ fontSize: "14px", color: "var(--text-secondary)", margin: 0 }}>
            Sign in to continue
          </p>
        </div>

        <form onSubmit={handleLogin}>
          {[
            { label: "Email", value: email, onChange: setEmail, type: "email", testid: "login-email" },
            { label: "Password", value: password, onChange: setPassword, type: "password", testid: "login-password" },
          ].map((f) => (
            <div key={f.label} style={{ marginBottom: "16px" }}>
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
                {f.label}
              </label>
              <input
                data-testid={f.testid}
                type={f.type}
                value={f.value}
                onChange={(e) => f.onChange(e.target.value)}
                required
                style={{
                  width: "100%",
                  height: "42px",
                  border: "1px solid var(--border)",
                  borderRadius: "6px",
                  padding: "0 12px",
                  fontSize: "14px",
                  background: "var(--bg-page)",
                  color: "var(--text-primary)",
                  outline: "none",
                }}
              />
            </div>
          ))}

          {error && (
            <p style={{ color: "var(--brand)", fontSize: "13px", margin: "0 0 12px" }}>
              {error}
            </p>
          )}

          <button
            data-testid="login-submit"
            type="submit"
            disabled={loading}
            style={{
              width: "100%",
              padding: "12px",
              background: loading ? "var(--bg-disabled)" : "var(--brand)",
              color: loading ? "var(--text-secondary)" : "var(--btn-primary-text)",
              border: "none",
              borderRadius: "6px",
              fontSize: "14px",
              fontWeight: 600,
              cursor: loading ? "not-allowed" : "pointer",
            }}
          >
            {loading ? "Signing in…" : "Sign In"}
          </button>
        </form>
      </div>
    </div>
  );
}
