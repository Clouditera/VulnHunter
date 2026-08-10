/**
 * Users management section — admin only.
 * Table with user list + create/edit/reset-password modals.
 */

import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { CSSProperties } from "react";
import { api, type UserApi } from "../../../shared/api/client.js";
import { ApiError } from "../../../shared/api/error.js";
import { i18n } from "../../../shared/i18n/index.js";
import { Icon } from "../../../shared/components/Icon.js";
import { useConfirmClose } from "../../../shared/hooks/useConfirmClose.js";

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
  const [deleteTarget, setDeleteTarget] = useState<UserApi | null>(null);

  const [actionError, setActionError] = useState("");
  const deleteMut = useMutation({
    mutationFn: (id: string) => api.users.delete(id),
    onSuccess: () => {
      setActionError("");
      qc.invalidateQueries({ queryKey: ["users"] });
    },
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : String(err));
    },
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
            <Icon name="users" size={18} style={{ color: "var(--text-secondary)" }} />
            <span>{i18n.t("settings.users.title")}</span>
          </h3>
          <p style={DESC}>{i18n.t("settings.users.desc")}</p>
        </div>
        <button onClick={() => setShowCreate(true)} style={PRIMARY_BTN}>
          {i18n.t("settings.users.create")}
        </button>
      </div>

      {actionError ? (
        <div data-testid="users-action-error" style={{ color: "var(--danger)", fontSize: 13, marginBottom: 12 }}>
          {actionError}
        </div>
      ) : null}

      {/* Table — no overflow:hidden so action menu can escape */}
      <div style={{ border: "1px solid var(--divider)", borderRadius: "8px" }}>
        <div style={{ ...ROW, background: "var(--bg-page)", fontWeight: 600, fontSize: "11px", color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.04em", borderTopLeftRadius: "8px", borderTopRightRadius: "8px" }}>
          <div style={{ width: "24px" }} />
          <div style={{ flex: 1 }}>{i18n.t("settings.users.col.email")}</div>
          <div style={{ width: "120px" }}>{i18n.t("settings.users.col.name")}</div>
          <div style={{ width: "180px" }}>{i18n.t("settings.users.col.remark")}</div>
          <div style={{ width: "100px" }}>{i18n.t("settings.users.col.role")}</div>
          <div style={{ width: "90px" }}>{i18n.t("settings.users.col.source")}</div>
          <div style={{ width: "110px" }}>{i18n.t("settings.users.col.taskLimit")}</div>
          <div style={{ width: "100px" }}>{i18n.t("settings.users.col.lastLogin")}</div>
          <div style={{ width: "40px" }} />
        </div>

        {users.map((u, idx) => {
          const isLast = idx === users.length - 1;
          return (
          <div
            key={u.id}
            data-status={u.status}
            style={{
              ...ROW,
              // Suspended users stay fully interactive for admin actions
              // (re-enable must remain clickable — fish 2026-08-03).
              // Visual cue: muted text only, not whole-row opacity.
              ...(isLast ? { borderBottom: "none", borderBottomLeftRadius: "8px", borderBottomRightRadius: "8px" } : {}),
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
          >
            <div style={{ width: "24px", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <span style={{
                width: "8px", height: "8px", borderRadius: "50%",
                background: u.status === "active" ? "var(--status-completed, var(--status-completed))" : "transparent",
                border: u.status === "active" ? "none" : "1.5px solid var(--text-secondary)",
              }} />
            </div>
            <div style={{
              flex: 1, fontSize: "13px", fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0, whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: 8,
              color: u.status === "suspended" ? "var(--text-secondary)" : "var(--text-primary)",
            }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{u.email}</span>
              {u.is_system ? <SystemBadge /> : null}
              {u.status === "suspended" ? <SuspendedBadge /> : null}
            </div>
            <div style={{ width: "120px", fontSize: "13px", color: u.display_name ? (u.status === "suspended" ? "var(--text-secondary)" : "var(--text-primary)") : "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{u.display_name || "—"}</div>
            <div title={u.admin_remark ?? ""} style={{ width: "180px", fontSize: "12px", color: u.admin_remark ? "var(--text-primary)" : "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{u.admin_remark || "—"}</div>
            <div style={{ width: "100px" }}>
              <RoleBadge role={u.role} />
            </div>
            <div style={{ width: "90px" }}>
              {/* System account: hide the source badge (fish 2026-08-06 —
                  管理员创建 marker is meaningless for the built-in admin). */}
              {u.is_system ? (
                <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>—</span>
              ) : (
                <SourceBadge source={u.source} />
              )}
            </div>
            <div style={{ width: "110px", fontSize: "12px", color: "var(--text-secondary)" }}>{formatTaskLimit(u)}</div>
            <div style={{ width: "100px", fontSize: "12px", color: "var(--text-secondary)" }}>{relativeTime(u.last_login_at)}</div>
            <div style={{ width: "40px", position: "relative" }}>
              {/* System admin menu (fish 2026-08-07 终拍, task-7cff2ecf):
                  DB 单一权威, 零来源判定 — menu always renders with
                  reset-password as a REAL action; disable/delete/edit stay
                  un-rendered (铁律). Backend guards migrate to last-admin. */}
              <button
                data-testid={`user-menu-btn-${u.id}`}
                onClick={() => setMenuOpen(menuOpen === u.id ? null : u.id)}
                style={{ ...GHOST_BTN, fontSize: "16px", padding: "4px 8px" }}
              >⋯</button>
              {menuOpen === u.id && (
                <ActionMenu
                  user={u}
                  onEdit={() => { setEditUser(u); setMenuOpen(null); }}
                  onResetPwd={() => { setResetPwdUser(u); setMenuOpen(null); }}
                  onToggle={() => { toggleMut.mutate({ id: u.id, status: u.status === "active" ? "suspended" : "active" }); setMenuOpen(null); }}
                  onDelete={() => { setDeleteTarget(u); setMenuOpen(null); }}
                  onClose={() => setMenuOpen(null)}
                  users={users}
                />
              )}
            </div>
          </div>
          );
        })}
      </div>

      {showCreate && <CreateUserModal onClose={() => setShowCreate(false)} onSuccess={() => { setShowCreate(false); qc.invalidateQueries({ queryKey: ["users"] }); }} />}
      {editUser && <EditUserModal user={editUser} onClose={() => setEditUser(null)} onSuccess={() => { setEditUser(null); qc.invalidateQueries({ queryKey: ["users"] }); }} />}
      {resetPwdUser && <ResetPasswordModal user={resetPwdUser} onClose={() => setResetPwdUser(null)} onSuccess={() => { setResetPwdUser(null); qc.invalidateQueries({ queryKey: ["users"] }); }} />}
      {deleteTarget && <ConfirmDeleteModal user={deleteTarget} onClose={() => setDeleteTarget(null)} onConfirm={() => { deleteMut.mutate(deleteTarget.id); setDeleteTarget(null); }} />}
    </section>
  );
}

function formatTaskLimit(user: UserApi): string {
  const used = user.task_count ?? 0;
  const limit = user.task_limit ?? 0;
  return limit > 0 ? `${used}/${limit}` : `${used}/∞`;
}


function SourceBadge({ source }: { source?: string }) {
  const registered = source === "registered";
  const label = registered
    ? i18n.t("settings.users.source.registered")
    : i18n.t("settings.users.source.admin");
  return (
    <span
      data-testid="user-source-badge"
      style={{
        display: "inline-block",
        fontSize: "11px",
        fontWeight: 600,
        padding: "2px 7px",
        borderRadius: "999px",
        background: registered ? "rgba(37,99,235,0.1)" : "var(--bg-page)",
        color: registered ? "var(--brand)" : "var(--text-secondary)",
        border: `1px solid ${registered ? "rgba(37,99,235,0.25)" : "var(--border)"}`,
      }}
    >
      {label}
    </span>
  );
}

function SuspendedBadge() {
  return (
    <span
      data-testid="user-suspended-badge"
      style={{
        flexShrink: 0,
        fontSize: 10,
        fontWeight: 600,
        padding: "2px 7px",
        borderRadius: 999,
        background: "var(--bg-page)",
        color: "var(--text-secondary)",
        border: "1px solid var(--border)",
      }}
    >
      {i18n.t("settings.users.status.suspended") || "已禁用"}
    </span>
  );
}

function SystemBadge() {
  return (
    <span
      data-testid="user-system-badge"
      style={{
        flexShrink: 0,
        fontSize: 10,
        fontWeight: 700,
        padding: "2px 7px",
        borderRadius: 999,
        background: "rgba(37,99,235,0.12)",
        color: "var(--brand)",
        border: "1px solid rgba(37,99,235,0.3)",
        letterSpacing: "0.02em",
      }}
    >
      {i18n.t("settings.users.systemBadge")}
    </span>
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

function ActionMenu({ user, users, onEdit, onResetPwd, onToggle, onDelete, onClose }: {
  user: UserApi; users: UserApi[]; onEdit: () => void; onResetPwd: () => void; onToggle: () => void; onDelete: () => void; onClose: () => void;
}) {
  const isLastAdmin = user.role === "admin" && users.filter((x) => x.role === "admin" && x.status === "active").length <= 1;
  // System admin: reset-password is a real action (DB sole authority,
  // fish 2026-08-07); disable/delete/edit stay un-rendered (铁律).
  if (user.is_system) {
    return (
      <>
        <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 999 }} />
        <div style={MENU}>
          <button data-testid={`user-menu-reset-${user.id}`} onClick={onResetPwd} style={MENU_ITEM}>
            {i18n.t("settings.users.menu.resetPassword")}
          </button>
        </div>
      </>
    );
  }
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
        <button
          onClick={isLastAdmin ? undefined : onDelete}
          disabled={isLastAdmin}
          title={isLastAdmin ? i18n.t("userModal.err.lastAdmin") : ""}
          style={{ ...MENU_ITEM, color: isLastAdmin ? "var(--text-secondary)" : "var(--brand)", opacity: isLastAdmin ? 0.5 : 1, cursor: isLastAdmin ? "not-allowed" : "pointer" }}
        >{i18n.t("settings.users.menu.delete")}</button>
      </div>
    </>
  );
}

/* ── Create User Modal ── */
function CreateUserModal({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPwd, setShowPwd] = useState(false);
  const [forceChange, setForceChange] = useState(true);
  const [taskLimit, setTaskLimit] = useState("0");
  const [adminRemark, setAdminRemark] = useState("");
  const [error, setError] = useState("");
  const [emailError, setEmailError] = useState("");
  // Unified modal base (fish 2026-08-07): ESC closes, dirty asks first,
  // backdrop never closes (ModalOverlay has no backdrop handler).
  const requestClose = useConfirmClose(
    onClose,
    email !== "" || displayName !== "" || password !== "" || confirmPassword !== "" || adminRemark.trim() !== "" || taskLimit !== "0" || !forceChange,
    true,
  );

  const mut = useMutation({
    mutationFn: () => {
      if (password !== confirmPassword) throw new Error(i18n.t("userModal.err.passwordMismatch"));
      // role always member — system admin is deploy-provisioned only
      return api.users.create({ email, password, display_name: displayName || undefined, role: "member", must_change_password: forceChange, task_limit: Math.max(0, Number(taskLimit) || 0), admin_remark: adminRemark.trim() || null });
    },
    onSuccess,
    onError: (err: Error) => {
      // fish 2026-08-10 (task-476d9cdb): surface the SPECIFIC field reason —
      // server ERR_VALIDATION carries details.field; email gets an inline
      // message under its input instead of the generic「请求参数有误」.
      if (err instanceof ApiError && err.code === "ERR_INVALID_EMAIL") {
        // Dedicated code (developer 57d5a9fa): message already localized server-side.
        setEmailError(err.message || i18n.t("userModal.err.emailInvalid"));
        return;
      }
      if (err instanceof ApiError && err.code === "ERR_VALIDATION" && err.details?.field === "email") {
        setEmailError(i18n.t("userModal.err.emailInvalid"));
        return;
      }
      setError(err.message);
    },
  });

  // fish 2026-08-10: same email rule as backend (a@b.c) — client pre-check,
  // inline error, submit blocked while invalid (前置禁用+原因提示).
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const emailInvalid = email.trim() !== "" && !EMAIL_RE.test(email.trim());
  const emailEmpty = email.trim() === "";

  return (
    <ModalOverlay onClose={onClose}>
      <div style={MODAL}>
        <div style={MODAL_HEADER}><span style={{ fontSize: "15px", fontWeight: 600 }}>{i18n.t("userModal.create.title")}</span><CloseBtn onClick={requestClose} /></div>
        <div style={MODAL_BODY}>
          <Field label={i18n.t("userModal.email")}>
            <input
              data-testid="user-create-email"
              type="email"
              value={email}
              onChange={(e) => { setEmail(e.target.value); setEmailError(""); }}
              style={{ ...INPUT, borderColor: emailInvalid || emailError ? "var(--danger)" : undefined }}
              placeholder="user@example.com"
            />
            {(emailInvalid || emailError) && (
              <div data-testid="user-create-email-error" style={{ color: "var(--danger)", fontSize: "12px", marginTop: "4px" }}>
                {i18n.t("userModal.err.emailInvalid")}
              </div>
            )}
          </Field>
          <Field label={i18n.t("userModal.displayName.optional")}><input value={displayName} onChange={(e) => setDisplayName(e.target.value)} style={INPUT} /></Field>
          {/* Admin role removed — singleton system admin is deploy-provisioned only. */}
          <Field label={i18n.t("userModal.taskLimit")}><input type="number" min={0} value={taskLimit} onChange={(e) => setTaskLimit(e.target.value)} style={INPUT} /></Field>
          <Field label={i18n.t("userModal.adminRemark.optional")}>
            <textarea value={adminRemark} onChange={(e) => setAdminRemark(e.target.value)} maxLength={1000} rows={3} style={{ ...INPUT, height: "auto", resize: "vertical" }} />
            <div style={HINT}>{i18n.t("userModal.adminRemarkHint")}</div>
          </Field>
          <Field label={i18n.t("userModal.initialPassword")}>
            <PwdInput value={password} onChange={setPassword} show={showPwd} onToggle={() => setShowPwd(!showPwd)} />
            <div style={HINT}>{i18n.t("userModal.passwordHint")}</div>
          </Field>
          <Field label={i18n.t("userModal.confirmPassword")}>
            <PwdInput value={confirmPassword} onChange={setConfirmPassword} show={showPwd} onToggle={() => setShowPwd(!showPwd)} />
          </Field>
          <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", cursor: "pointer", color: "var(--text-primary)" }}>
            <input type="checkbox" checked={forceChange} onChange={(e) => setForceChange(e.target.checked)} />
            {i18n.t("userModal.forceChangePassword")}
          </label>
          {error && <div style={{ color: "var(--brand)", fontSize: "12px" }}>{error}</div>}
        </div>
        <div style={MODAL_FOOTER}>
          <button onClick={requestClose} style={GHOST_BTN_STYLED}>{i18n.t("userModal.cancel")}</button>
          <button data-testid="user-create-submit" onClick={() => mut.mutate()} disabled={emailEmpty || emailInvalid || password.length < 8 || confirmPassword.length < 8 || password !== confirmPassword || mut.isPending} style={{ ...PRIMARY_BTN, opacity: emailEmpty || emailInvalid || password.length < 8 || confirmPassword.length < 8 || password !== confirmPassword ? 0.5 : 1 }}>
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
  const [disabled, setDisabled] = useState(user.status === "suspended");
  const [taskLimit, setTaskLimit] = useState(String(user.task_limit ?? 0));
  const [adminRemark, setAdminRemark] = useState(user.admin_remark ?? "");
  const [error, setError] = useState("");
  const requestClose = useConfirmClose(
    onClose,
    displayName !== user.display_name ||
      disabled !== (user.status === "suspended") ||
      taskLimit !== String(user.task_limit ?? 0) ||
      adminRemark !== (user.admin_remark ?? ""),
    true,
  );

  const mut = useMutation({
    mutationFn: () =>
      api.users.update(user.id, {
        display_name: displayName,
        // role not editable via UI — system admin is deploy-only; members stay members
        status: disabled ? "suspended" : "active",
        task_limit: Math.max(0, Number(taskLimit) || 0),
        admin_remark: adminRemark.trim() || null,
      }),
    onSuccess,
    onError: (err: Error) => setError(err.message),
  });

  return (
    <ModalOverlay onClose={onClose}>
      <div style={MODAL}>
        <div style={MODAL_HEADER}><span style={{ fontSize: "15px", fontWeight: 600 }}>{i18n.t("userModal.edit.title")}</span><CloseBtn onClick={requestClose} /></div>
        <div style={MODAL_BODY}>
          <Field label={i18n.t("userModal.email")}><input value={user.email} readOnly title={i18n.t("userModal.emailReadonly")} style={{ ...INPUT, background: "var(--bg-page)", cursor: "not-allowed" }} /></Field>
          <Field label={i18n.t("userModal.displayName")}><input value={displayName} onChange={(e) => setDisplayName(e.target.value)} style={INPUT} maxLength={64} /></Field>
          <Field label={i18n.t("userModal.taskLimit")}><input type="number" min={0} value={taskLimit} onChange={(e) => setTaskLimit(e.target.value)} style={INPUT} /></Field>
          <Field label={i18n.t("userModal.adminRemark.optional")}>
            <textarea value={adminRemark} onChange={(e) => setAdminRemark(e.target.value)} maxLength={1000} rows={3} style={{ ...INPUT, height: "auto", resize: "vertical" }} />
            <div style={HINT}>{i18n.t("userModal.adminRemarkHint")}</div>
          </Field>
          <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", cursor: "pointer", color: "var(--text-primary)" }}>
            <ToggleSwitch checked={disabled} onChange={setDisabled} />
            {i18n.t("userModal.disable")}
          </label>
          {error && <div style={{ color: "var(--brand)", fontSize: "12px" }}>{error}</div>}
        </div>
        <div style={MODAL_FOOTER}>
          <button onClick={requestClose} style={GHOST_BTN_STYLED}>{i18n.t("userModal.cancel")}</button>
          <button onClick={() => mut.mutate()} disabled={mut.isPending} style={PRIMARY_BTN}>{mut.isPending ? "..." : i18n.t("userModal.save")}</button>
        </div>
      </div>
    </ModalOverlay>
  );
}

/* ── Reset Password Modal ── */
function ResetPasswordModal({ user, onClose, onSuccess }: { user: UserApi; onClose: () => void; onSuccess: () => void }) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPwd, setShowPwd] = useState(false);
  const [error, setError] = useState("");
  const requestClose = useConfirmClose(onClose, password !== "" || confirmPassword !== "", true);

  const mut = useMutation({
    mutationFn: () => {
      if (password !== confirmPassword) throw new Error(i18n.t("userModal.err.passwordMismatch"));
      return api.users.update(user.id, { reset_password: password });
    },
    onSuccess,
    onError: (err: Error) => setError(err.message),
  });

  return (
    <ModalOverlay onClose={onClose}>
      <div style={{ ...MODAL, width: "380px" }}>
        <div style={MODAL_HEADER}><span style={{ fontSize: "15px", fontWeight: 600 }}>{i18n.t("resetPwd.title")} · {user.email}</span><CloseBtn onClick={requestClose} /></div>
        <div style={MODAL_BODY}>
          <Field label={i18n.t("resetPwd.newPassword")}>
            <PwdInput value={password} onChange={setPassword} show={showPwd} onToggle={() => setShowPwd(!showPwd)} />
            <div style={HINT}>{i18n.t("userModal.passwordHint")}</div>
          </Field>
          <Field label={i18n.t("userModal.confirmPassword")}>
            <PwdInput value={confirmPassword} onChange={setConfirmPassword} show={showPwd} onToggle={() => setShowPwd(!showPwd)} />
          </Field>
          {error && <div style={{ color: "var(--brand)", fontSize: "12px" }}>{error}</div>}
        </div>
        <div style={MODAL_FOOTER}>
          <button onClick={requestClose} style={GHOST_BTN_STYLED}>{i18n.t("userModal.cancel")}</button>
          <button onClick={() => mut.mutate()} disabled={password.length < 8 || confirmPassword.length < 8 || password !== confirmPassword || mut.isPending} style={{ ...PRIMARY_BTN, opacity: password.length < 8 || confirmPassword.length < 8 || password !== confirmPassword ? 0.5 : 1 }}>
            {mut.isPending ? "..." : i18n.t("resetPwd.confirm")}
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
}

/* ── Shared primitives ── */

function ModalOverlay({ children }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999, padding: "20px", boxSizing: "border-box" }}>
      <div>{children}</div>
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
const MODAL: CSSProperties = { width: "440px", maxHeight: "85vh", borderRadius: "12px", background: "var(--bg-card)", boxShadow: "0 20px 60px rgba(0,0,0,0.15)", overflow: "hidden", display: "flex", flexDirection: "column" };
const MODAL_HEADER: CSSProperties = { padding: "18px 24px", borderBottom: "1px solid var(--divider)", display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 };
const MODAL_BODY: CSSProperties = { padding: "20px 24px", display: "flex", flexDirection: "column", gap: "16px", overflowY: "auto", flex: 1, minHeight: 0 };
const MODAL_FOOTER: CSSProperties = { padding: "14px 24px", borderTop: "1px solid var(--divider)", display: "flex", justifyContent: "flex-end", gap: "8px", flexShrink: 0 };
const INPUT: CSSProperties = { width: "100%", padding: "9px 12px", border: "1px solid var(--border)", borderRadius: "6px", fontSize: "13px", background: "var(--bg-card)", color: "var(--text-primary)", outline: "none", fontFamily: "inherit", boxSizing: "border-box" };
const LABEL: CSSProperties = { display: "block", fontSize: "12px", fontWeight: 600, color: "var(--text-primary)", marginBottom: "6px" };
const HINT: CSSProperties = { fontSize: "11px", color: "var(--text-secondary)", marginTop: "4px" };

function ToggleSwitch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      style={{
        width: "36px", height: "20px", borderRadius: "10px", border: "none", cursor: "pointer",
        background: checked ? "var(--brand)" : "var(--border)", position: "relative", transition: "background 0.2s",
      }}
    >
      <span style={{
        position: "absolute", top: "2px", left: checked ? "18px" : "2px",
        width: "16px", height: "16px", borderRadius: "50%", background: "#fff",
        transition: "left 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
      }} />
    </button>
  );
}

function ConfirmDeleteModal({ user, onClose, onConfirm }: { user: UserApi; onClose: () => void; onConfirm: () => void }) {
  return (
    <ModalOverlay onClose={onClose}>
      <div style={{ ...MODAL, width: "380px" }}>
        <div style={MODAL_HEADER}><span style={{ fontSize: "15px", fontWeight: 600 }}>{i18n.t("settings.users.menu.delete")}</span><CloseBtn onClick={onClose} /></div>
        <div style={MODAL_BODY}>
          <p style={{ margin: 0, fontSize: "13px", color: "var(--text-primary)" }}>
            {i18n.t("settings.users.confirmDelete") || `确认删除用户 ${user.email}？此操作不可撤销。`}
          </p>
        </div>
        <div style={MODAL_FOOTER}>
          <button onClick={onClose} style={GHOST_BTN_STYLED}>{i18n.t("userModal.cancel")}</button>
          <button onClick={onConfirm} style={{ ...PRIMARY_BTN }}>{i18n.t("settings.users.menu.delete")}</button>
        </div>
      </div>
    </ModalOverlay>
  );
}
