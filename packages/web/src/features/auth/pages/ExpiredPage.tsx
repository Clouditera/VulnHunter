import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../../shared/api/client.js";

export function ExpiredPage() {
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();

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
      setError("Invalid renewal key. Please contact your vendor.");
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
              background: "#fff7ed",
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
            License Expired
          </h1>
          <p style={{ fontSize: "14px", color: "var(--text-secondary)", margin: 0, lineHeight: 1.6 }}>
            Your license has expired. Please contact your vendor to obtain a renewal key.
          </p>
        </div>

        {success ? (
          <div
            style={{
              padding: "12px 16px",
              background: "#f0fdf4",
              border: "1px solid #bbf7d0",
              borderRadius: "6px",
              color: "#166534",
              fontSize: "14px",
            }}
          >
            ✅ Renewed successfully — redirecting…
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
              Renewal Key
            </label>
            <textarea
              data-testid="renewal-key-input"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="Paste your renewal license certificate JSON here"
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
                background: loading || !key.trim() ? "#e5e5e5" : "var(--brand)",
                color: loading || !key.trim() ? "var(--text-secondary)" : "#fff",
                border: "none",
                borderRadius: "6px",
                fontSize: "14px",
                fontWeight: 600,
                cursor: loading || !key.trim() ? "not-allowed" : "pointer",
              }}
            >
              {loading ? "Renewing…" : "Renew License"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
