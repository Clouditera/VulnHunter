/**
 * First-login forced password change page.
 * Uses AuthSplitLayout (same as Login). Cannot be bypassed (route guard).
 */

import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../../shared/api/client.js";
import { i18n } from "../../../shared/i18n/index.js";
import { AuthSplitLayout } from "../../../shared/components/AuthSplitLayout.js";
import { Icon } from "../../../shared/components/Icon.js";

export function ChangePasswordPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [, forceI18n] = useState(0);
  useEffect(() => i18n.onChange(() => forceI18n((n) => n + 1)), []);

  const [currentPwd, setCurrentPwd] = useState("");
  const [newPwd, setNewPwd] = useState("");
  const [confirmPwd, setConfirmPwd] = useState("");
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  function validate(): string | null {
    if (newPwd.length < 8) return i18n.t("userModal.passwordHint");
    if (newPwd === currentPwd) return i18n.t("forceChangePwd.err.sameAsCurrent");
    if (newPwd !== confirmPwd) return i18n.t("forceChangePwd.err.mismatch");
    return null;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const v = validate();
    if (v) { setError(v); return; }
    setError("");
    setLoading(true);
    try {
      await api.auth.forceChangePassword(newPwd);
      qc.invalidateQueries({ queryKey: ["system-status"] });
      navigate("/dashboard");
    } catch (err) {
      setError((err as Error).message || "Failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleLogout() {
    await api.auth.logout();
    qc.invalidateQueries({ queryKey: ["system-status"] });
    navigate("/login");
  }

  const canSubmit = currentPwd.length > 0 && newPwd.length >= 8 && newPwd === confirmPwd && !loading;

  return (
    <AuthSplitLayout testid="change-password-page">
      <form onSubmit={handleSubmit} style={{ maxWidth: "340px", width: "100%" }}>
        <h2 style={{ fontSize: "20px", fontWeight: 700, color: "var(--text-primary)", margin: "0 0 8px" }}>
          {i18n.t("forceChangePwd.title")}
        </h2>
        <p style={{ fontSize: "13px", color: "var(--text-secondary)", margin: "0 0 24px" }}>
          {i18n.t("forceChangePwd.desc")}
        </p>

        <div style={{ borderTop: "1px solid var(--divider)", margin: "0 0 20px" }} />

        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          <PwdField label={i18n.t("profile.currentPassword")} value={currentPwd} onChange={setCurrentPwd} show={showCurrent} onToggle={() => setShowCurrent(!showCurrent)} />
          <div>
            <PwdField label={i18n.t("profile.newPassword")} value={newPwd} onChange={setNewPwd} show={showNew} onToggle={() => setShowNew(!showNew)} />
            <div style={{ fontSize: "11px", color: "var(--text-secondary)", marginTop: "4px" }}>{i18n.t("userModal.passwordHint")}</div>
          </div>
          <PwdField label={i18n.t("profile.confirmPassword")} value={confirmPwd} onChange={setConfirmPwd} show={showConfirm} onToggle={() => setShowConfirm(!showConfirm)} />
        </div>

        {error && <div style={{ color: "var(--danger)", fontSize: "12px", marginTop: "8px" }}>{error}</div>}

        <button
          type="submit"
          disabled={!canSubmit}
          style={{
            width: "100%", marginTop: "24px", padding: "12px",
            background: "var(--brand)", color: "#fff", border: "none",
            borderRadius: "8px", fontSize: "14px", fontWeight: 600,
            cursor: canSubmit ? "pointer" : "default", opacity: canSubmit ? 1 : 0.5,
          }}
        >
          {loading ? "..." : i18n.t("forceChangePwd.submit")}
        </button>

        <button
          type="button"
          onClick={handleLogout}
          style={{
            width: "100%", marginTop: "12px", padding: "8px",
            background: "transparent", border: "none",
            color: "var(--text-secondary)", fontSize: "12px",
            cursor: "pointer",
          }}
        >
          {i18n.t("forceChangePwd.logout")}
        </button>
      </form>
    </AuthSplitLayout>
  );
}

function PwdField({ label, value, onChange, show, onToggle }: {
  label: string; value: string; onChange: (v: string) => void; show: boolean; onToggle: () => void;
}) {
  return (
    <div>
      <label style={{ display: "block", fontSize: "12px", fontWeight: 600, color: "var(--text-primary)", marginBottom: "6px" }}>{label}</label>
      <div style={{ position: "relative" }}>
        <input
          type={show ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={{
            width: "100%", padding: "9px 40px 9px 12px", boxSizing: "border-box",
            border: "1px solid var(--border)", borderRadius: "6px", fontSize: "13px",
            background: "var(--bg-card)", color: "var(--text-primary)", outline: "none",
          }}
        />
        <button
          type="button"
          onClick={onToggle}
          style={{
            position: "absolute", right: "8px", top: "50%", transform: "translateY(-50%)",
            background: "transparent", border: "none", cursor: "pointer", color: "var(--text-secondary)", padding: "4px",
          }}
        >
          <Icon name={show ? "eye-off" : "eye"} size={14} />
        </button>
      </div>
    </div>
  );
}
