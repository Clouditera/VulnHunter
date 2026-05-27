/**
 * Personal settings section — all users.
 * Email (readonly) + display name + change password form.
 */

import { useState, useEffect } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CSSProperties } from "react";
import { api } from "../../../shared/api/client.js";
import { i18n } from "../../../shared/i18n/index.js";
import { Icon } from "../../../shared/components/Icon.js";
import { useSystemStatus } from "../../auth/hooks/useSystemStatus.js";

export function ProfileSection() {
  const [, force] = useState(0);
  useEffect(() => i18n.onChange(() => force((n) => n + 1)), []);
  const qc = useQueryClient();
  const { data: status } = useSystemStatus();
  const user = status?.user;

  const [displayName, setDisplayName] = useState("");
  const [nameLoaded, setNameLoaded] = useState(false);
  const [nameSaved, setNameSaved] = useState(false);

  // Sync displayName from server once
  useEffect(() => {
    if (user?.displayName && !nameLoaded) {
      setDisplayName(user.displayName);
      setNameLoaded(true);
    }
  }, [user?.displayName, nameLoaded]);

  const saveNameMut = useMutation({
    mutationFn: () => api.auth.updateMe({ display_name: displayName }),
    onSuccess: () => {
      setNameSaved(true);
      qc.invalidateQueries({ queryKey: ["system-status"] });
      setTimeout(() => setNameSaved(false), 2000);
    },
  });

  const [currentPwd, setCurrentPwd] = useState("");
  const [newPwd, setNewPwd] = useState("");
  const [confirmPwd, setConfirmPwd] = useState("");
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [pwdError, setPwdError] = useState("");
  const [pwdSaved, setPwdSaved] = useState(false);

  const changePwdMut = useMutation({
    mutationFn: () => api.auth.changePassword(currentPwd, newPwd),
    onSuccess: () => {
      setPwdSaved(true);
      setCurrentPwd("");
      setNewPwd("");
      setConfirmPwd("");
      setPwdError("");
      setTimeout(() => setPwdSaved(false), 2000);
    },
    onError: (err: Error) => setPwdError(err.message || i18n.t("profile.err.wrongCurrent")),
  });

  function handleChangePwd() {
    if (newPwd.length < 8) { setPwdError(i18n.t("userModal.passwordHint")); return; }
    if (newPwd !== confirmPwd) { setPwdError(i18n.t("profile.err.mismatch")); return; }
    setPwdError("");
    changePwdMut.mutate();
  }

  const canSubmitPwd = currentPwd.length > 0 && newPwd.length >= 8 && newPwd === confirmPwd && !changePwdMut.isPending;

  return (
    <section style={CARD} data-testid="settings-card-profile">
      <h3 style={TITLE}>
        <Icon name="user" size={18} style={{ color: "var(--text-secondary)" }} />
        <span>{i18n.t("profile.title")}</span>
      </h3>
      <p style={DESC}>{i18n.t("profile.desc")}</p>

      {/* Email (readonly) */}
      <div style={{ ...FORM_COLUMN, marginTop: "16px" }}>
        <label style={LABEL}>{i18n.t("userModal.email")}</label>
        <input value={user?.email ?? ""} readOnly style={{ ...INPUT, background: "var(--bg-page)" }} />
      </div>

      {/* Display name (editable) */}
      <div style={{ ...FORM_COLUMN, marginTop: "12px" }}>
        <label style={LABEL}>{i18n.t("userModal.displayName")}</label>
        <input
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          maxLength={64}
          style={INPUT}
        />
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "10px" }}>
          <button
            onClick={() => saveNameMut.mutate()}
            disabled={saveNameMut.isPending}
            style={{ ...PRIMARY_BTN, whiteSpace: "nowrap" }}
          >
            {saveNameMut.isPending ? "..." : nameSaved ? i18n.t("profile.saved") : i18n.t("profile.saveName")}
          </button>
        </div>
      </div>

      <div style={{ borderTop: "1px solid var(--divider)", margin: "20px 0" }} />

      {/* Change password */}
      <h4 style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-primary)", margin: "0 0 12px" }}>
        {i18n.t("profile.savePassword")}
      </h4>
      <div style={{ ...FORM_COLUMN, display: "flex", flexDirection: "column", gap: "12px" }}>
        <PwdField label={i18n.t("profile.currentPassword")} value={currentPwd} onChange={setCurrentPwd} show={showCurrent} onToggle={() => setShowCurrent(!showCurrent)} />
        <div>
          <PwdField label={i18n.t("profile.newPassword")} value={newPwd} onChange={setNewPwd} show={showNew} onToggle={() => setShowNew(!showNew)} />
          <div style={{ fontSize: "11px", color: "var(--text-secondary)", marginTop: "4px" }}>{i18n.t("userModal.passwordHint")}</div>
        </div>
        <PwdField label={i18n.t("profile.confirmPassword")} value={confirmPwd} onChange={setConfirmPwd} show={showConfirm} onToggle={() => setShowConfirm(!showConfirm)} />

        {pwdError && <div style={{ color: "var(--brand)", fontSize: "12px" }}>{pwdError}</div>}

        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button
            onClick={handleChangePwd}
            disabled={!canSubmitPwd}
            style={{ ...PRIMARY_BTN, opacity: canSubmitPwd ? 1 : 0.5 }}
          >
            {changePwdMut.isPending ? "..." : pwdSaved ? i18n.t("profile.saved") : i18n.t("profile.savePassword")}
          </button>
        </div>
      </div>
    </section>
  );
}

function PwdField({ label, value, onChange, show, onToggle }: {
  label: string; value: string; onChange: (v: string) => void; show: boolean; onToggle: () => void;
}) {
  return (
    <div>
      <label style={LABEL}>{label}</label>
      <div style={{ position: "relative" }}>
        <input
          type={show ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={{ ...INPUT, paddingRight: "40px" }}
        />
        <button
          type="button"
          onClick={onToggle}
          style={{ position: "absolute", right: "8px", top: "50%", transform: "translateY(-50%)", background: "transparent", border: "none", cursor: "pointer", color: "var(--text-secondary)", padding: "4px" }}
        >
          <Icon name={show ? "eye-off" : "eye"} size={14} />
        </button>
      </div>
    </div>
  );
}

const CARD: CSSProperties = { background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: "12px", padding: "24px", marginBottom: "16px" };
const TITLE: CSSProperties = { fontSize: "15px", fontWeight: 600, margin: "0 0 4px", display: "flex", alignItems: "center", gap: "8px", color: "var(--text-primary)" };
const DESC: CSSProperties = { fontSize: "13px", color: "var(--text-secondary)", opacity: 0.85, margin: 0 };
const LABEL: CSSProperties = { display: "block", fontSize: "12px", fontWeight: 600, color: "var(--text-primary)", marginBottom: "6px" };
const FORM_COLUMN: CSSProperties = { width: "100%" };
const INPUT: CSSProperties = { width: "100%", padding: "9px 12px", border: "1px solid var(--border)", borderRadius: "6px", fontSize: "13px", background: "var(--bg-card)", color: "var(--text-primary)", outline: "none", fontFamily: "inherit", boxSizing: "border-box" };
const PRIMARY_BTN: CSSProperties = { padding: "8px 18px", border: "none", borderRadius: "6px", background: "var(--brand)", color: "var(--btn-primary-text, #fff)", fontSize: "13px", fontWeight: 600, cursor: "pointer" };
