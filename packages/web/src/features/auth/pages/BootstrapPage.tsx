import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../../shared/api/client.js";

export function BootstrapPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await api.system.bootstrap(email, password);
      qc.invalidateQueries({ queryKey: ["system-status"] });
      navigate("/login");
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      data-testid="bootstrap-page"
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
          <div style={{ fontSize: "32px", marginBottom: "12px" }}>🛡️</div>
          <h1 style={{ fontSize: "22px", fontWeight: 700, margin: "0 0 8px" }}>
            Create Admin Account
          </h1>
          <p style={{ fontSize: "14px", color: "var(--text-secondary)", margin: 0 }}>
            Set up the initial administrator account
          </p>
        </div>

        <form onSubmit={handleSubmit}>
          {[
            { label: "Email", value: email, onChange: setEmail, type: "email", testid: "bootstrap-email" },
            { label: "Password (min 8 chars)", value: password, onChange: setPassword, type: "password", testid: "bootstrap-password" },
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
                  height: "40px",
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
            data-testid="bootstrap-submit"
            type="submit"
            disabled={loading}
            style={{
              width: "100%",
              padding: "12px",
              background: loading ? "#e5e5e5" : "var(--brand)",
              color: loading ? "var(--text-secondary)" : "#fff",
              border: "none",
              borderRadius: "6px",
              fontSize: "14px",
              fontWeight: 600,
              cursor: loading ? "not-allowed" : "pointer",
            }}
          >
            {loading ? "Creating…" : "Create Admin Account"}
          </button>
        </form>
      </div>
    </div>
  );
}
