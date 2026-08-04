/**
 * Settings → API 令牌 self-service (PRD + design-spec v1.0).
 * Plaintext shown once at create; list never returns secrets.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ApiToken } from "../../../shared/api/client.js";
import { i18n } from "../../../shared/i18n/index.js";
import { Icon } from "../../../shared/components/Icon.js";
import { toast } from "../../../shared/toast/toast.js";
import { useConfirmClose } from "../../../shared/hooks/useConfirmClose.js";
import { copyText } from "../../../shared/lib/copy-text.js";
import { formatRelativeTime } from "../../../shared/utils/format.js";

const EXPIRY_OPTIONS: Array<{ days: number | null; labelKey: string }> = [
  { days: 30, labelKey: "settings.tokens.expiry.30" },
  { days: 90, labelKey: "settings.tokens.expiry.90" },
  { days: 365, labelKey: "settings.tokens.expiry.365" },
  { days: null, labelKey: "settings.tokens.expiry.forever" },
];

function formatDateYmd(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function tokenMeta(t: ApiToken): string {
  const created = `${i18n.t("settings.tokens.created")} ${formatDateYmd(t.created_at)}`;
  let exp: string;
  if (!t.expires_at) {
    exp = i18n.t("settings.tokens.expiry.forever");
  } else {
    exp = `${i18n.t("settings.tokens.expires")} ${formatDateYmd(t.expires_at)}`;
  }
  const last = t.last_used_at
    ? `${i18n.t("settings.tokens.lastUsed")} ${formatRelativeTime(t.last_used_at)}`
    : i18n.t("settings.tokens.neverUsed");
  return `${created} · ${exp} · ${last}`;
}

function statusLabel(status: ApiToken["status"]): string {
  if (status === "active") return i18n.t("settings.tokens.status.active");
  if (status === "disabled") return i18n.t("settings.tokens.status.disabled");
  if (status === "expired") return i18n.t("settings.tokens.status.expired");
  return i18n.t("settings.tokens.status.revoked");
}

function statusDot(status: ApiToken["status"]): string {
  if (status === "active") return "#3AD186";
  if (status === "disabled") return "var(--warn, #FF733C)";
  return "var(--text-tertiary, #BBC3CC)";
}

export function ApiTokensSection() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["api-tokens"],
    queryFn: () => api.apiTokens.list(),
  });
  const tokens = data?.tokens ?? [];
  const limit = data?.limit ?? 10;
  const count = data?.count ?? tokens.filter((t) => t.revoked_at == null).length;
  const atCap = count >= limit;

  const [showCreate, setShowCreate] = useState(false);
  const [reveal, setReveal] = useState<{ name: string; plaintext: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ApiToken | null>(null);
  const [renameTarget, setRenameTarget] = useState<ApiToken | null>(null);

  const createMut = useMutation({
    mutationFn: (body: { name: string; expires_in_days: number | null }) =>
      api.apiTokens.create(body),
    onSuccess: (res) => {
      setShowCreate(false);
      setReveal({ name: res.token.name, plaintext: res.plaintext });
      qc.invalidateQueries({ queryKey: ["api-tokens"] });
    },
    onError: (err) => {
      const code = (err as { code?: string }).code;
      if (code === "ERR_API_TOKEN_LIMIT") {
        toast.error(i18n.t("settings.tokens.cap"));
      } else {
        toast.error(err instanceof Error ? err.message : i18n.t("settings.tokens.createFail"));
      }
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.apiTokens.remove(id),
    onSuccess: () => {
      setDeleteTarget(null);
      toast.success(i18n.t("settings.tokens.deleteOk"));
      qc.invalidateQueries({ queryKey: ["api-tokens"] });
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : i18n.t("settings.tokens.deleteFail"));
    },
  });

  const statusMut = useMutation({
    mutationFn: ({ id, status }: { id: string; status: "active" | "disabled" }) =>
      api.apiTokens.setStatus(id, status),
    onSuccess: (_data, vars) => {
      toast.success(
        i18n.t(vars.status === "disabled" ? "settings.tokens.disableOk" : "settings.tokens.enableOk"),
      );
      qc.invalidateQueries({ queryKey: ["api-tokens"] });
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : i18n.t("settings.tokens.statusFail"));
    },
  });

  const renameMut = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.apiTokens.rename(id, name),
    onSuccess: () => {
      setRenameTarget(null);
      toast.success(i18n.t("settings.tokens.renameOk"));
      qc.invalidateQueries({ queryKey: ["api-tokens"] });
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : i18n.t("settings.tokens.renameFail"));
    },
  });

  const sorted = useMemo(() => tokens, [tokens]);

  return (
    <section
      data-testid="settings-card-tokens"
      style={{
        background: "var(--bg-card)",
        borderRadius: "12px",
        padding: "24px",
        border: "1px solid var(--border)",
        marginBottom: "16px",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: "12px",
          marginBottom: "18px",
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3
            style={{
              fontSize: "15px",
              fontWeight: 600,
              margin: "0 0 4px",
              display: "flex",
              alignItems: "center",
              gap: "8px",
              color: "var(--text-primary)",
            }}
          >
            <Icon name="key" size={18} style={{ color: "var(--text-secondary)" }} />
            <span>{i18n.t("settings.tokens.title")}</span>
          </h3>
          <p
            style={{
              fontSize: "13px",
              color: "var(--text-secondary)",
              opacity: 0.85,
              margin: 0,
              lineHeight: 1.5,
            }}
          >
            {i18n.t("settings.tokens.desc")}{" "}
            <code
              style={{
                fontFamily: "ui-monospace, Menlo, Consolas, monospace",
                fontSize: "12px",
                background: "var(--bg-hover)",
                padding: "1px 6px",
                borderRadius: "4px",
              }}
            >
              Authorization: Bearer &lt;token&gt;
            </code>
          </p>
        </div>
        {sorted.length > 0 ? (
          <button
            type="button"
            data-testid="settings-token-create-btn"
            onClick={() => setShowCreate(true)}
            disabled={atCap}
            style={{
              padding: "6px 12px",
              border: "1px solid var(--border)",
              borderRadius: "6px",
              background: "var(--bg-card)",
              color: "var(--text-primary)",
              fontSize: "12px",
              fontWeight: 600,
              cursor: atCap ? "not-allowed" : "pointer",
              opacity: atCap ? 0.5 : 1,
              flexShrink: 0,
            }}
          >
            + {i18n.t("settings.tokens.create")}
          </button>
        ) : null}
      </div>

      {atCap ? (
        <div
          data-testid="settings-token-cap-banner"
          style={{
            marginBottom: "14px",
            padding: "10px 12px",
            borderRadius: "8px",
            background: "rgba(245, 158, 11, 0.12)",
            color: "var(--text-primary)",
            fontSize: "12.5px",
            lineHeight: 1.45,
          }}
        >
          {i18n.t("settings.tokens.cap")}
        </div>
      ) : null}

      {isLoading ? (
        <div style={{ color: "var(--text-secondary)", fontSize: "13px" }}>
          {i18n.t("settings.loading")}
        </div>
      ) : sorted.length === 0 ? (
        <div
          data-testid="settings-token-empty"
          style={{
            border: "1px dashed var(--border)",
            borderRadius: "10px",
            padding: "28px 20px",
            textAlign: "center",
          }}
        >
          <div
            style={{
              width: 44,
              height: 44,
              margin: "0 auto 12px",
              borderRadius: 10,
              background: "var(--brand-soft, rgba(37, 99, 235, 0.12))",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--brand)",
            }}
          >
            <Icon name="key" size={22} />
          </div>
          <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)", marginBottom: 6 }}>
            {i18n.t("settings.tokens.emptyTitle")}
          </div>
          <p
            style={{
              fontSize: 12.5,
              color: "var(--text-secondary)",
              margin: "0 0 16px",
              lineHeight: 1.55,
              maxWidth: 420,
              marginLeft: "auto",
              marginRight: "auto",
            }}
          >
            {i18n.t("settings.tokens.emptyBody")}
          </p>
          <button
            type="button"
            data-testid="settings-token-create-empty-btn"
            onClick={() => setShowCreate(true)}
            style={{
              padding: "8px 16px",
              border: "none",
              borderRadius: "8px",
              background: "var(--brand)",
              color: "#fff",
              fontSize: "13px",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {i18n.t("settings.tokens.create")}
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {sorted.map((t) => {
            const inactive = t.status !== "active";
            return (
              <div
                key={t.id}
                data-testid={`settings-token-row-${t.id}`}
                data-status={t.status}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "12px 14px",
                  borderRadius: 8,
                  border: "1px solid var(--border)",
                  background: "var(--bg-page, var(--bg-card))",
                  opacity: inactive ? 0.62 : 1,
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      color: "var(--text-primary)",
                      marginBottom: 4,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {t.name}
                  </div>
                  {t.token_prefix ? (
                    <div
                      style={{
                        fontSize: 11,
                        fontFamily: "ui-monospace, Menlo, Consolas, monospace",
                        color: "var(--text-tertiary, var(--text-secondary))",
                        lineHeight: 1.4,
                      }}
                    >
                      {t.token_prefix}…
                    </div>
                  ) : null}
                  <div
                    style={{
                      fontSize: 11,
                      fontFamily: "ui-monospace, Menlo, Consolas, monospace",
                      color: "var(--text-secondary)",
                      lineHeight: 1.4,
                    }}
                  >
                    {tokenMeta(t)}
                  </div>
                </div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    flexShrink: 0,
                    fontSize: 12,
                    color: inactive ? "var(--text-secondary)" : "var(--text-primary)",
                  }}
                >
                  <span
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: "50%",
                      background: statusDot(t.status),
                      display: "inline-block",
                    }}
                  />
                  {statusLabel(t.status)}
                </div>
                <TokenRowMenu
                  token={t}
                  onRename={() => setRenameTarget(t)}
                  onToggleStatus={() =>
                    statusMut.mutate({
                      id: t.id,
                      status: t.status === "disabled" ? "active" : "disabled",
                    })
                  }
                  onDelete={() => setDeleteTarget(t)}
                />
              </div>
            );
          })}
          <p
            style={{
              margin: "8px 0 0",
              fontSize: 11.5,
              color: "var(--text-secondary)",
              lineHeight: 1.45,
            }}
          >
            {i18n.t("settings.tokens.footerNote")}
          </p>
        </div>
      )}

      {showCreate ? (
        <CreateTokenModal
          busy={createMut.isPending}
          onClose={() => setShowCreate(false)}
          onSubmit={(name, days) => createMut.mutate({ name, expires_in_days: days })}
        />
      ) : null}
      {reveal ? (
        <RevealTokenModal
          name={reveal.name}
          plaintext={reveal.plaintext}
          onClose={() => {
            setReveal(null);
            toast.success(i18n.t("settings.tokens.createdToast"));
          }}
        />
      ) : null}
      {deleteTarget ? (
        <DeleteConfirmModal
          token={deleteTarget}
          busy={deleteMut.isPending}
          onClose={() => setDeleteTarget(null)}
          onConfirm={() => deleteMut.mutate(deleteTarget.id)}
        />
      ) : null}
      {renameTarget ? (
        <RenameTokenModal
          token={renameTarget}
          busy={renameMut.isPending}
          onClose={() => setRenameTarget(null)}
          onSubmit={(name) => renameMut.mutate({ id: renameTarget.id, name })}
        />
      ) : null}
    </section>
  );
}

/** Row ⋯ menu: rename / disable|enable / delete. Available ops depend on status. */
function TokenRowMenu({
  token,
  onRename,
  onToggleStatus,
  onDelete,
}: {
  token: ApiToken;
  onRename: () => void;
  onToggleStatus: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const canManage = token.status === "active" || token.status === "disabled";

  const itemStyle = (danger = false): CSSProperties => ({
    display: "block",
    width: "100%",
    textAlign: "left",
    padding: "7px 12px",
    border: "none",
    background: "transparent",
    color: danger ? "var(--danger, #dc2626)" : "var(--text-primary)",
    fontSize: 12.5,
    fontWeight: 500,
    cursor: "pointer",
    fontFamily: "inherit",
    whiteSpace: "nowrap",
  });

  return (
    <div ref={wrapRef} style={{ position: "relative", flexShrink: 0 }}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid={`settings-token-menu-${token.id}`}
        onClick={() => setOpen((v) => !v)}
        style={{
          width: 28,
          height: 28,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          border: "1px solid var(--border)",
          borderRadius: 6,
          background: "var(--bg-card)",
          color: "var(--text-secondary)",
          fontSize: 14,
          lineHeight: 1,
          cursor: "pointer",
          fontFamily: "inherit",
        }}
      >
        ⋯
      </button>
      {open ? (
        <div
          role="menu"
          data-testid={`settings-token-menu-panel-${token.id}`}
          style={{
            position: "absolute",
            right: 0,
            top: "calc(100% + 4px)",
            zIndex: 100,
            minWidth: 120,
            background: "var(--bg-card)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            boxShadow: "0 8px 24px rgba(15, 23, 42, 0.18)",
            padding: 4,
          }}
        >
          {canManage ? (
            <>
              <button
                type="button"
                role="menuitem"
                data-testid={`settings-token-menu-rename-${token.id}`}
                onClick={() => {
                  setOpen(false);
                  onRename();
                }}
                style={itemStyle()}
              >
                {i18n.t("settings.tokens.rename")}
              </button>
              <button
                type="button"
                role="menuitem"
                data-testid={`settings-token-menu-toggle-${token.id}`}
                onClick={() => {
                  setOpen(false);
                  onToggleStatus();
                }}
                style={itemStyle()}
              >
                {i18n.t(
                  token.status === "disabled" ? "settings.tokens.enable" : "settings.tokens.disable",
                )}
              </button>
            </>
          ) : null}
          <button
            type="button"
            role="menuitem"
            data-testid={`settings-token-menu-delete-${token.id}`}
            onClick={() => {
              setOpen(false);
              onDelete();
            }}
            style={itemStyle(true)}
          >
            {i18n.t("settings.tokens.delete")}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ghostBtn(disabled: boolean): CSSProperties {
  return {
    padding: "4px 10px",
    border: "1px solid var(--border)",
    borderRadius: 6,
    background: "var(--bg-card)",
    color: "var(--text-secondary)",
    fontSize: 11.5,
    fontWeight: 500,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
    fontFamily: "inherit",
  };
}

function Overlay({ children, onClose, dirty = false }: { children: ReactNode; onClose: () => void; dirty?: boolean }) {
  const requestClose = useConfirmClose(onClose, dirty);
  return (
    <div
      role="dialog"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: "rgba(15, 23, 42, 0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
    >
      {children}
    </div>
  );
}

function CreateTokenModal({
  busy,
  onClose,
  onSubmit,
}: {
  busy: boolean;
  onClose: () => void;
  onSubmit: (name: string, days: number | null) => void;
}) {
  const [name, setName] = useState("");
  const [days, setDays] = useState<number | null>(90);
  const requestClose = useConfirmClose(onClose, name.trim() !== "");
  return (
    <Overlay onClose={requestClose}>
      <div
        data-testid="settings-token-create-modal"
        style={{
          width: 460,
          maxWidth: "100%",
          background: "var(--bg-card)",
          borderRadius: 12,
          border: "1px solid var(--border)",
          padding: 20,
          boxShadow: "0 16px 48px rgba(0,0,0,0.18)",
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 16, color: "var(--text-primary)" }}>
          {i18n.t("settings.tokens.createTitle")}
        </div>
        <label style={labelStyle}>{i18n.t("settings.tokens.nameLabel")}</label>
        <input
          data-testid="settings-token-name-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={i18n.t("settings.tokens.namePlaceholder")}
          style={inputStyle}
        />
        <div style={{ fontSize: 11.5, color: "var(--text-secondary)", margin: "4px 0 14px" }}>
          {i18n.t("settings.tokens.nameHint")}
        </div>
        <label style={labelStyle}>{i18n.t("settings.tokens.expiryLabel")}</label>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)",
            gap: 8,
            marginBottom: 8,
          }}
        >
          {EXPIRY_OPTIONS.map((o) => {
            const active = days === o.days;
            return (
              <button
                key={String(o.days)}
                type="button"
                data-testid={`settings-token-expiry-${o.days ?? "forever"}`}
                onClick={() => setDays(o.days)}
                style={{
                  padding: "8px 4px",
                  borderRadius: 8,
                  border: active ? "1px solid var(--brand)" : "1px solid var(--border)",
                  background: active ? "var(--brand-soft, rgba(37,99,235,0.1))" : "var(--bg-card)",
                  color: active ? "var(--brand)" : "var(--text-primary)",
                  fontSize: 12,
                  fontWeight: active ? 600 : 500,
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                {i18n.t(o.labelKey)}
              </button>
            );
          })}
        </div>
        <div style={{ fontSize: 11.5, color: "var(--text-secondary)", marginBottom: 18 }}>
          {i18n.t("settings.tokens.expiryHint")}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" onClick={requestClose} style={ghostBtn(false)}>
            {i18n.t("settings.tokens.cancel")}
          </button>
          <button
            type="button"
            data-testid="settings-token-create-submit"
            disabled={busy || !name.trim()}
            onClick={() => onSubmit(name.trim(), days)}
            style={{
              padding: "7px 14px",
              border: "none",
              borderRadius: 8,
              background: "var(--brand)",
              color: "#fff",
              fontSize: 13,
              fontWeight: 600,
              cursor: busy || !name.trim() ? "not-allowed" : "pointer",
              opacity: busy || !name.trim() ? 0.6 : 1,
            }}
          >
            {i18n.t("settings.tokens.create")}
          </button>
        </div>
      </div>
    </Overlay>
  );
}

function RevealTokenModal({
  name,
  plaintext,
  onClose,
}: {
  name: string;
  plaintext: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <Overlay onClose={onClose}>
      <div
        data-testid="settings-token-reveal-modal"
        style={{
          width: 460,
          maxWidth: "100%",
          background: "var(--bg-card)",
          borderRadius: 12,
          border: "1px solid var(--border)",
          padding: 20,
          boxShadow: "0 16px 48px rgba(0,0,0,0.18)",
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6, color: "var(--text-primary)" }}>
          {i18n.t("settings.tokens.revealTitle")}
        </div>
        <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 12 }}>{name}</div>
        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "flex-start",
            padding: "10px 12px",
            borderRadius: 8,
            border: "1px solid var(--brand)",
            background: "var(--brand-soft, rgba(37,99,235,0.06))",
            marginBottom: 12,
          }}
        >
          <code
            data-testid="settings-token-plaintext"
            style={{
              flex: 1,
              fontFamily: "ui-monospace, Menlo, Consolas, monospace",
              fontSize: 13,
              fontWeight: 600,
              wordBreak: "break-all",
              color: "var(--text-primary)",
              lineHeight: 1.45,
            }}
          >
            {plaintext}
          </code>
          <button
            type="button"
            data-testid="settings-token-copy-btn"
            onClick={async () => {
              const ok = await copyText(plaintext);
              if (ok) {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1200);
              } else {
                toast.error(i18n.t("settings.tokens.copyFail"));
              }
            }}
            style={{
              flexShrink: 0,
              padding: "4px 10px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--bg-card)",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
              color: "var(--brand)",
            }}
          >
            {copied ? "✓" : i18n.t("settings.tokens.copy")}
          </button>
        </div>
        <div
          style={{
            padding: "10px 12px",
            borderRadius: 8,
            background: "rgba(245, 158, 11, 0.12)",
            color: "var(--text-primary)",
            fontSize: 12.5,
            lineHeight: 1.5,
            marginBottom: 16,
          }}
        >
          {i18n.t("settings.tokens.revealWarn")}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button
            type="button"
            data-testid="settings-token-reveal-done"
            onClick={onClose}
            style={{
              padding: "8px 16px",
              border: "none",
              borderRadius: 8,
              background: "var(--brand)",
              color: "#fff",
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {i18n.t("settings.tokens.revealDone")}
          </button>
        </div>
      </div>
    </Overlay>
  );
}

function DeleteConfirmModal({
  token,
  busy,
  onClose,
  onConfirm,
}: {
  token: ApiToken;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Overlay onClose={onClose}>
      <div
        data-testid="settings-token-delete-modal"
        style={{
          width: 420,
          maxWidth: "100%",
          background: "var(--bg-card)",
          borderRadius: 12,
          border: "1px solid var(--border)",
          padding: 20,
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 12, color: "var(--text-primary)" }}>
          {i18n.t("settings.tokens.deleteTitle")}
        </div>
        <code
          style={{
            display: "inline-block",
            padding: "4px 10px",
            borderRadius: 6,
            background: "var(--bg-hover)",
            fontSize: 12.5,
            fontFamily: "ui-monospace, Menlo, Consolas, monospace",
            marginBottom: 12,
          }}
        >
          {token.name}
        </code>
        <p style={{ fontSize: 13, color: "var(--danger, #dc2626)", lineHeight: 1.5, margin: "0 0 16px" }}>
          {i18n.t("settings.tokens.deleteWarn")}
        </p>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" onClick={onClose} style={ghostBtn(false)}>
            {i18n.t("settings.tokens.cancel")}
          </button>
          <button
            type="button"
            data-testid="settings-token-delete-confirm"
            disabled={busy}
            onClick={onConfirm}
            style={{
              padding: "7px 14px",
              border: "none",
              borderRadius: 8,
              background: "var(--danger, #dc2626)",
              color: "#fff",
              fontSize: 13,
              fontWeight: 600,
              cursor: busy ? "not-allowed" : "pointer",
              opacity: busy ? 0.7 : 1,
            }}
          >
            {i18n.t("settings.tokens.deleteConfirm")}
          </button>
        </div>
      </div>
    </Overlay>
  );
}

function RenameTokenModal({
  token,
  busy,
  onClose,
  onSubmit,
}: {
  token: ApiToken;
  busy: boolean;
  onClose: () => void;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState(token.name);
  const requestClose = useConfirmClose(onClose, name !== token.name);
  return (
    <Overlay onClose={requestClose}>
      <div
        data-testid="settings-token-rename-modal"
        style={{
          width: 420,
          maxWidth: "100%",
          background: "var(--bg-card)",
          borderRadius: 12,
          border: "1px solid var(--border)",
          padding: 20,
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 14, color: "var(--text-primary)" }}>
          {i18n.t("settings.tokens.renameTitle")}
        </div>
        <input
          data-testid="settings-token-rename-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={inputStyle}
        />
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button type="button" onClick={requestClose} style={ghostBtn(false)}>
            {i18n.t("settings.tokens.cancel")}
          </button>
          <button
            type="button"
            data-testid="settings-token-rename-submit"
            disabled={busy || !name.trim()}
            onClick={() => onSubmit(name.trim())}
            style={{
              padding: "7px 14px",
              border: "none",
              borderRadius: 8,
              background: "var(--brand)",
              color: "#fff",
              fontSize: 13,
              fontWeight: 600,
              cursor: busy || !name.trim() ? "not-allowed" : "pointer",
            }}
          >
            {i18n.t("settings.tokens.rename")}
          </button>
        </div>
      </div>
    </Overlay>
  );
}

const labelStyle: CSSProperties = {
  display: "block",
  fontSize: 12,
  fontWeight: 600,
  color: "var(--text-secondary)",
  marginBottom: 6,
};

const inputStyle: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "8px 10px",
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "var(--bg-page, var(--bg-card))",
  color: "var(--text-primary)",
  fontSize: 13,
  fontFamily: "inherit",
  outline: "none",
};
