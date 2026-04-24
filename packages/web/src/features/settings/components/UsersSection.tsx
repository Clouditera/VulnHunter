/**
 * Users management section — admin only.
 * Table with user list + create/edit/reset-password modals.
 */

import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { CSSProperties } from "react";
import { api, type UserApi } from "../../../shared/api/client.js";
import { i18n } from "../../../shared/i18n/index.js";
import { Icon } from "../../../shared/components/Icon.js";

export function UsersSection() {
  const [, force] = useState(0);
  useEffect(() => i18n.onChange(() => force((n) => n + 1)), []);
  const qc = useQueryClient();

  const { data } = useQuery({ queryKey: ["users"], queryFn: () => api.users.list() });
  const users = data?.users ?? [];

  const [showCreate, setShowCreate] = useState(false);
  const [editUser, setEditUser] = useState<UserApi | null>(null);
  const [resetPwdUser, setResetPwdUser] = useState<UserApi | null>(null);
  const [menuOpen, setMenuOpen] = useState<string | null>(null);

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.users.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
  });

  const toggleMut = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      api.users.update(id, { status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
  });

  function relativeTime(d: string | null): string {
    if (!d) return i18n.t("settings.users.never");
    const ms = Date.now() - new Date(d).getTime();
    if (ms < 60_000) return "刚刚";
    if (ms < 3600_000) return `${Math.floor(ms / 60_000)}m 前`;
    if (ms < 86400_000) return `${Math.floor(ms / 3600_000)}h 前`;
    return `${Math.floor(ms / 86400_000)}d 前`;
  }

  return (
    <section style={CARD} data-testid="settings-card-users">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "16px" }}>
        <div>
          <h3 style={TITLE}>
            <Icon name="shield" size={18} style={{ color: "var(--text-secondary)" }} />
            <span>{i18n.t("settings.users.title")}</span>
          </h3>
          <p style={DESC}>{i18n.t("settings.users.desc")}</p>
        </div>
        <button onClick={() => setShowCreate(true)} style={PRIMARY_BTN}>
          {i18n.t("settings.users.create")}
        </button>
      </div>

      {/* Table */}
      <div style={{ border: "1px solid var(--divider)", borderRadius: "8px", overflow: "hidden" }}>
        <div style={{ ...ROW, background: "var(--bg-page)", fontWeight: 600, fontSize: "11px", color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
          <div style={{ width: "24px" }} />
          <div style={{ flex: 1 }}>{i18n.t("settings.users.col.email")}</div>
          <div style={{ width: "120px" }}>{i18n.t("settings.users.col.name")}</div>
          <div style={{ width: "100px" }}>{i18n.t("settings.users.col.role")}</div>
          <div style={{ width: "100px" }}>{i18n.t("settings.users.col.lastLogin")}</div>
          <div style={{ width: "40px" }} />
        </div>

        {users.map((u) => (
          <div
            key={u.id}
            style={{ ...ROW, opacity: u.status === "suspended" ? 0.55 : 1 }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
          >
            <div style={{ width: "24px", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <span style={{
                width: "8px", height: "8px", borderRadius: "50%",
                background: u.status === "active" ? "#16a34a" : "transparent",
                border: u.status === "active" ? "none" : "1.5px solid var(--text-secondary)",
              }} />
            </div>
            <div style={{ flex: 1, fontSize: "13px", fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis" }}>{u.email}</div>
            <div style={{ width: "120px", fontSize: "13px", color: u.display_name ? "var(--text-primary)" : "var(--text-secondary)" }}>{u.display_name || "—"}</div>
            <div style={{ width: "100px" }}>
              <RoleBadge role={u.role} />
            </div>
            <div style={{ width: "100px", fontSize: "12px", color: "var(--text-secondary)" }}>{relativeTime(u.last_login_at)}</div>
            <div style={{ width: "40px", position: "relative" }}>
              <button
                onClick={() => setMenuOpen(menuOpen === u.id ? null : u.id)}
                style={{ ...GHOST_BTN, fontSize: "16px", padding: "4px 8px" }}
              >⋯</button>
              {menuOpen === u.id && (
                <ActionMenu
                  user={u}
                  onEdit={() => { setEditUser(u); setMenuOpen(null); }}
                  onResetPwd={() => { setResetPwdUser(u); setMenuOpen(null); }}
                  onToggle={() => { toggleMut.mutate({ id: u.id, status: u.status === "active" ? "suspended" : "active" }); setMenuOpen(null); }}
                  onDelete={() => { if (window.confirm(`删除用户 ${u.email}？`)) deleteMut.mutate(u.id); setMenuOpen(null); }}
                  onClose={() => setMenuOpen(null)}
                />
              )}
            </div>
          </div>
        ))}
      </div>

      {showCreate && <CreateUserModal onClose={() => setShowCreate(false)} onSuccess={() => { setShowCreate(false); qc.invalidateQueries({ queryKey: ["users"] }); }} />}
      {editUser && <EditUserModal user={editUser} onClose={() => setEditUser(null)} onSuccess={() => { setEditUser(null); qc.invalidateQueries({ queryKey: ["users"] }); }} />}
      {resetPwdUser && <ResetPasswordModal user={resetPwdUser} onClose={() => setResetPwdUser(null)} onSuccess={() => { setResetPwdUser(null); qc.invalidateQueries({ queryKey: ["users"] }); }} />}
    </section>
  );
}

function RoleBadge({ role }: { role: string }) {
  const isAdmin = role === "admin";
  return (
    <span style={{
      padding: "2px 8px", borderRadius: "4px", fontSize: "10px", fontWeight: isAdmin ? 600 : 500,
      border: isAdmin ? "1px solid var(--brand)" : "1px solid var(--border)",
      color: isAdmin ? "var(--brand)" : "var(--text-secondary)",
      background: isAdmin ? "transparent" : "var(--bg-page)",
    }}>
      {isAdmin ? "Admin" : "User"}
    </span>
  );
}

function ActionMenu({ user, onEdit, onResetPwd, onToggle, onDelete, onClose }: {
  user: UserApi; onEdit: () => void; onResetPwd: () => void; onToggle: () => void; onDelete: () => void; onClose: () => void;
}) {
  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 999 }} />
      <div style={MENU}>
        <button onClick={onEdit} style={MENU_ITEM}>{i18n.t("settings.users.menu.edit")}</button>
        <button onClick={onResetPwd} style={MENU_ITEM}>{i18n.t("settings.users.menu.resetPassword")}</button>
        <div style={{ borderTop: "1px solid var(--divider)", margin: "4px 0" }} />
        <button onClick={onToggle} style={MENU_ITEM}>
          {user.status === "active" ? i18n.t("settings.users.menu.disable") : i18n.t("settings.users.menu.enable")}
        </button>
        <button onClick={onDelete} style={{ ...MENU_ITEM, color: "var(--brand)" }}>{i18n.t("settings.users.menu.delete")}</button>
      </div>
    </>
  );
}

/* ── Create User Modal ── */
function CreateUserModal({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");
  const [password, setPassword] = useState("");
  const [showPwd, setShowPwd] = useState(false);
  const [error, setError] = useState("");

  const mut = useMutation({
    mutationFn: () => api.users.create({ email, password, display_name: displayName || undefined, role }),
    onSuccess,
    onError: (err: Error) => setError(err.message),
  });

  return (
    <ModalOverlay onClose={onClose}>
      <div style={MODAL}>
        <div style={MODAL_HEADER}><span style={{ fontSize: "15px", fontWeight: 600 }}>{i18n.t("userModal.create.title")}</span><CloseBtn onClick={onClose} /></div>
        <div style={MODAL_BODY}>
          <Field label={i18n.t("userModal.email")}><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} style={INPUT} placeholder="user@example.com" /></Field>
          <Field label={i18n.t("userModal.displayName.optional")}><input value={displayName} onChange={(e) => setDisplayName(e.target.value)} style={INPUT} /></Field>
          <Field label={i18n.t("userModal.role")}>
            <div style={{ display: "flex", gap: "12px" }}>
              <RadioBtn active={role === "admin"} onClick={() => setRole("admin")} label={i18n.t("userModal.role.admin")} />
              <RadioBtn active={role === "member"} onClick={() => setRole("member")} label={i18n.t("userModal.role.user")} />
            </div>
          </Field>
          <Field label={i18n.t("userModal.initialPassword")}>
            <PwdInput value={password} onChange={setPassword} show={showPwd} onToggle={() => setShowPwd(!showPwd)} />
            <div style={HINT}>{i18n.t("userModal.passwordHint")}</div>
          </Field>
          {error && <div style={{ color: "var(--brand)", fontSize: "12px" }}>{error}</div>}
        </div>
        <div style={MODAL_FOOTER}>
          <button onClick={onClose} style={GHOST_BTN_STYLED}>{i18n.t("userModal.cancel")}</button>
          <button onClick={() => mut.mutate()} disabled={!email || password.length < 8 || mut.isPending} style={{ ...PRIMARY_BTN, opacity: !email || password.length < 8 ? 0.5 : 1 }}>
            {mut.isPending ? "..." : i18n.t("userModal.create")}
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
}

/* ── Edit User Modal ── */
function EditUserModal({ user, onClose, onSuccess }: { user: UserApi; onClose: () => void; onSuccess: () => void }) {
  const [displayName, setDisplayName] = useState(user.display_name);
  const [role, setRole] = useState(user.role);
  const [error, setError] = useState("");

  const mut = useMutation({
    mutationFn: () => api.users.update(user.id, { display_name: displayName, role }),
    onSuccess,
    onError: (err: Error) => setError(err.message),
  });

  return (
    <ModalOverlay onClose={onClose}>
      <div style={MODAL}>
        <div style={MODAL_HEADER}><span style={{ fontSize: "15px", fontWeight: 600 }}>{i18n.t("userModal.edit.title")}</span><CloseBtn onClick={onClose} /></div>
        <div style={MODAL_BODY}>
          <Field label={i18n.t("userModal.email")}><input value={user.email} readOnly style={{ ...INPUT, background: "var(--bg-page)" }} /></Field>
          <Field label={i18n.t("userModal.displayName")}><input value={displayName} onChange={(e) => setDisplayName(e.target.value)} style={INPUT} /></Field>
          <Field label={i18n.t("userModal.role")}>
            <div style={{ display: "flex", gap: "12px" }}>
              <RadioBtn active={role === "admin"} onClick={() => setRole("admin")} label={i18n.t("userModal.role.admin")} />
              <RadioBtn active={role === "member"} onClick={() => setRole("member")} label={i18n.t("userModal.role.user")} />
            </div>
          </Field>
          {error && <div style={{ color: "var(--brand)", fontSize: "12px" }}>{error}</div>}
        </div>
        <div style={MODAL_FOOTER}>
          <button onClick={onClose} style={GHOST_BTN_STYLED}>{i18n.t("userModal.cancel")}</button>
          <button onClick={() => mut.mutate()} disabled={mut.isPending} style={PRIMARY_BTN}>{mut.isPending ? "..." : i18n.t("userModal.save")}</button>
        </div>
      </div>
    </ModalOverlay>
  );
}

/* ── Reset Password Modal ── */
function ResetPasswordModal({ user, onClose, onSuccess }: { user: UserApi; onClose: () => void; onSuccess: () => void }) {
  const [password, setPassword] = useState("");
  const [showPwd, setShowPwd] = useState(false);

  const mut = useMutation({
    mutationFn: () => api.users.update(user.id, { reset_password: password }),
    onSuccess,
  });

  return (
    <ModalOverlay onClose={onClose}>
      <div style={{ ...MODAL, width: "380px" }}>
        <div style={MODAL_HEADER}><span style={{ fontSize: "15px", fontWeight: 600 }}>{i18n.t("resetPwd.title")} · {user.email}</span><CloseBtn onClick={onClose} /></div>
        <div style={MODAL_BODY}>
          <Field label={i18n.t("resetPwd.newPassword")}>
            <PwdInput value={password} onChange={setPassword} show={showPwd} onToggle={() => setShowPwd(!showPwd)} />
            <div style={HINT}>{i18n.t("userModal.passwordHint")}</div>
          </Field>
        </div>
        <div style={MODAL_FOOTER}>
          <button onClick={onClose} style={GHOST_BTN_STYLED}>{i18n.t("userModal.cancel")}</button>
          <button onClick={() => mut.mutate()} disabled={password.length < 8 || mut.isPending} style={{ ...PRIMARY_BTN, opacity: password.length < 8 ? 0.5 : 1 }}>
            {mut.isPending ? "..." : i18n.t("resetPwd.confirm")}
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
}

/* ── Shared primitives ── */

function ModalOverlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999 }}>
      <div onClick={(e) => e.stopPropagation()}>{children}</div>
    </div>
  );
}

function CloseBtn({ onClick }: { onClick: () => void }) {
  return <button onClick={onClick} style={{ ...GHOST_BTN, padding: "4px" }}><Icon name="x" size={16} /></button>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><label style={LABEL}>{label}</label>{children}</div>;
}

function PwdInput({ value, onChange, show, onToggle }: { value: string; onChange: (v: string) => void; show: boolean; onToggle: () => void }) {
  return (
    <div style={{ position: "relative" }}>
      <input type={show ? "text" : "password"} value={value} onChange={(e) => onChange(e.target.value)} style={{ ...INPUT, paddingRight: "40px" }} />
      <button type="button" onClick={onToggle} style={{ position: "absolute", right: "8px", top: "50%", transform: "translateY(-50%)", ...GHOST_BTN, padding: "4px" }}>
        <Icon name={show ? "eye-off" : "eye"} size={14} />
      </button>
    </div>
  );
}

function RadioBtn({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button onClick={onClick} style={{
      flex: 1, padding: "8px 12px", border: `1px solid ${active ? "var(--brand)" : "var(--border)"}`,
      borderRadius: "6px", background: active ? "rgba(220,38,38,0.05)" : "transparent",
      color: active ? "var(--brand)" : "var(--text-primary)", fontSize: "12px", fontWeight: active ? 600 : 400, cursor: "pointer", textAlign: "left",
    }}>
      {label}
    </button>
  );
}

/* ── Styles ── */

const CARD: CSSProperties = { background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: "12px", padding: "24px", marginBottom: "16px" };
const TITLE: CSSProperties = { fontSize: "15px", fontWeight: 600, margin: "0 0 4px", display: "flex", alignItems: "center", gap: "8px", color: "var(--text-primary)" };
const DESC: CSSProperties = { fontSize: "13px", color: "var(--text-secondary)", opacity: 0.85, margin: 0 };
const ROW: CSSProperties = { display: "flex", alignItems: "center", padding: "12px", borderBottom: "1px solid var(--divider)", gap: "8px", transition: "background 0.12s" };
const GHOST_BTN: CSSProperties = { background: "transparent", border: "none", cursor: "pointer", color: "var(--text-secondary)", fontFamily: "inherit" };
const GHOST_BTN_STYLED: CSSProperties = { ...GHOST_BTN, padding: "8px 16px", fontSize: "13px" };
const PRIMARY_BTN: CSSProperties = { padding: "8px 18px", border: "none", borderRadius: "6px", background: "var(--brand)", color: "var(--btn-primary-text, #fff)", fontSize: "13px", fontWeight: 600, cursor: "pointer" };
const MENU: CSSProperties = { position: "absolute", right: 0, top: "100%", width: "160px", background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: "8px", boxShadow: "0 6px 20px rgba(0,0,0,0.08)", padding: "4px 0", zIndex: 1000 };
const MENU_ITEM: CSSProperties = { display: "block", width: "100%", padding: "8px 14px", border: "none", background: "transparent", fontSize: "13px", color: "var(--text-primary)", cursor: "pointer", textAlign: "left", fontFamily: "inherit" };
const MODAL: CSSProperties = { width: "440px", maxHeight: "80vh", borderRadius: "12px", background: "var(--bg-card)", boxShadow: "0 20px 60px rgba(0,0,0,0.15)", overflow: "hidden" };
const MODAL_HEADER: CSSProperties = { padding: "18px 24px", borderBottom: "1px solid var(--divider)", display: "flex", justifyContent: "space-between", alignItems: "center" };
const MODAL_BODY: CSSProperties = { padding: "20px 24px", display: "flex", flexDirection: "column", gap: "16px" };
const MODAL_FOOTER: CSSProperties = { padding: "14px 24px", borderTop: "1px solid var(--divider)", display: "flex", justifyContent: "flex-end", gap: "8px" };
const INPUT: CSSProperties = { width: "100%", padding: "9px 12px", border: "1px solid var(--border)", borderRadius: "6px", fontSize: "13px", background: "var(--bg-card)", color: "var(--text-primary)", outline: "none", fontFamily: "inherit", boxSizing: "border-box" };
const LABEL: CSSProperties = { display: "block", fontSize: "12px", fontWeight: 600, color: "var(--text-primary)", marginBottom: "6px" };
const HINT: CSSProperties = { fontSize: "11px", color: "var(--text-secondary)", marginTop: "4px" };
